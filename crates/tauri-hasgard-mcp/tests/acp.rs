//! The Hasgard tools reached over an ACP connection: an ACP client attaches the server to
//! its session and the agent calls a tool with `mcp/message`, with no stdio process and no
//! endpoint. MCP over ACP is a draft, so this pins the bridge's unstable features.

use agent_client_protocol::v2::{ConnectionTo, Responder, schema};
use agent_client_protocol::{Agent, Client, Error, mcp_server::McpServer, schema::ProtocolVersion};
use agent_client_protocol_rmcp::rmcp_3::McpServerExt;
use serde_json::json;
use tauri_hasgard_mcp::{HasgardMcpServer, RpcError};
use tokio::sync::oneshot;

#[tokio::test]
async fn agent_calls_a_hasgard_tool_over_acp() -> Result<(), Error> {
    let (done_tx, done_rx) = oneshot::channel();
    let mut done_tx = Some(done_tx);
    let agent = Agent
        .v2()
        .on_receive_request(
            async |request: schema::InitializeRequest,
                   responder: Responder<schema::InitializeResponse>,
                   _cx: ConnectionTo<Client>| {
                responder.respond(
                    schema::InitializeResponse::new(
                        request.protocol_version,
                        schema::Implementation::new("test-agent", "1"),
                    )
                    .capabilities(
                        schema::AgentCapabilities::new().session(
                            schema::SessionCapabilities::new()
                                .mcp(schema::McpCapabilities::new().acp(schema::McpAcpCapabilities::new())),
                        ),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: schema::NewSessionRequest,
                        responder: Responder<schema::NewSessionResponse>,
                        cx: ConnectionTo<Client>| {
                let [schema::McpServer::Acp(server)] = request.mcp_servers.as_slice() else {
                    return Err(Error::invalid_params().data("expected one native server"));
                };
                let server_id = server.server_id.clone();
                let done_tx = done_tx.take().expect("one session");
                let call_cx = cx.clone();
                cx.spawn(async move {
                    let params = json!({
                        "name": "hasgard.state",
                        "arguments": {"window": "settings"},
                        "_meta": {
                            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                            "io.modelcontextprotocol/clientCapabilities": {}
                        }
                    });
                    let response = call_cx
                        .send_request(
                            schema::MessageMcpRequest::new(server_id, "state-1", "tools/call")
                                .params(params.as_object().expect("object").clone()),
                        )
                        .block_task()
                        .await;
                    drop(done_tx.send(response));
                    Ok(())
                })?;
                responder.respond(schema::NewSessionResponse::new(schema::SessionId::new("session")))
            },
            agent_client_protocol::on_receive_request!(),
        );

    // The host's side: its application function becomes the server the agent talks to.
    let hasgard = || {
        HasgardMcpServer::in_process(
            |method, params| async move {
                if method == "state" {
                    Ok(json!({"url": "tauri://localhost", "window": params["window"]}))
                } else {
                    Err(RpcError { code: -32601, message: format!("{method} unavailable"), data: None })
                }
            },
            Some("main".to_owned()),
        )
    };

    Client
        .v2()
        .connect_with(agent, async move |cx| {
            cx.send_request(schema::InitializeRequest::new(
                ProtocolVersion::V2,
                schema::Implementation::new("test-host", "1"),
            ))
            .block_task()
            .await?;
            cx.build_session(std::env::current_dir().map_err(Error::into_internal_error)?)
                .with_mcp_server(McpServer::<Agent>::from_rmcp("tauri-hasgard", hasgard))?
                .start_session()
                .block_task()
                .await?;
            match done_rx.await.map_err(Error::into_internal_error)?? {
                schema::MessageMcpResponse::Result { result, .. } => {
                    let result = serde_json::to_value(result).map_err(Error::into_internal_error)?;
                    assert_eq!(
                        result["structuredContent"],
                        json!({"result": {"url": "tauri://localhost", "window": "settings"}}),
                        "{result}"
                    );
                }
                schema::MessageMcpResponse::Error { error, .. } => {
                    panic!("MCP error {}: {}", error.code, error.message)
                }
                _ => panic!("unknown MCP carrier"),
            }
            Ok(())
        })
        .await
}
