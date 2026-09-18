//! Bounded native window recording. One session per window, no desktop capture.
//! Frames and encoder output live in a private directory and publish only on success.
#[cfg(target_os = "macos")]
mod macos {
    use serde_json::{Value, json};
    use std::{
        collections::HashMap,
        io::Write,
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        sync::{Mutex, mpsc},
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };

    struct Session {
        stop: mpsc::Sender<()>,
        worker: Option<JoinHandle<Result<Value, String>>>,
    }
    impl Drop for Session {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            if let Some(worker) = self.worker.take() {
                // Every child has a deadline and is reaped. Drop cannot orphan an encoder.
                let _ = worker.join();
            }
        }
    }

    #[derive(Default)]
    pub(crate) struct Videos(Mutex<HashMap<String, Session>>);

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn run_bounded(command: &mut Command, timeout: Duration) -> Result<(), String> {
        let mut child = ChildGuard(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("start native recording process: {e}"))?,
        );
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "native recording process exited with {status}; check Screen Recording permission and ffmpeg installation"
                    ))
                };
            }
            if Instant::now() >= deadline {
                return Err("native recording process timed out".to_owned());
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn capture(window: u32, path: &Path) -> Result<(), String> {
        run_bounded(
            Command::new("/usr/sbin/screencapture").args(["-x", "-o", "-l"]).arg(window.to_string()).arg(path),
            Duration::from_secs(5),
        )?;
        let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
        if size == 0 {
            return Err("native capture returned an empty frame".to_owned());
        }
        Ok(())
    }

    fn encode(dir: &Path, output: &Path, width: u32, height: u32, fps: u64) -> Result<(), String> {
        let filter = format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
        );
        run_bounded(
            Command::new("ffmpeg")
                .current_dir(dir)
                .args(["-nostdin", "-v", "error", "-n", "-f", "concat", "-safe", "1", "-i", "frames.txt", "-vf"])
                .arg(filter)
                .args(["-r", &fps.to_string(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
                .arg(output),
            Duration::from_secs(30),
        )
    }

    impl Videos {
        pub fn start(&self, window: &str, id: u32, params: &Value) -> Result<Value, String> {
            let path = params.get("output_path").and_then(Value::as_str).ok_or("video.start requires output_path")?;
            let output = PathBuf::from(path);
            if !output.is_absolute() || output.extension().and_then(|s| s.to_str()) != Some("mp4") {
                return Err("video output_path must be an absolute .mp4 path".to_owned());
            }
            if output.symlink_metadata().is_ok() {
                return Err("video output_path already exists".to_owned());
            }
            let fps = integer(params, "fps", 5, 1, 10)?;
            let max_ms = integer(params, "max_duration_ms", 60_000, 100, 60_000)?;
            let parent = output.parent().ok_or("video output has no parent")?;
            let mut sessions = self.0.lock().map_err(|e| e.to_string())?;
            if sessions.contains_key(window) {
                return Err(format!("window '{window}' already has a video session"));
            }
            // Verify dependency and first real frame before returning success.
            run_bounded(Command::new("ffmpeg").arg("-version"), Duration::from_secs(3))?;
            let dir =
                tempfile::Builder::new().prefix(".hasgard-video-").tempdir_in(parent).map_err(|e| e.to_string())?;
            capture(id, &dir.path().join("frame-000000.png"))?;
            let (width, height) =
                image::image_dimensions(dir.path().join("frame-000000.png")).map_err(|e| e.to_string())?;
            if width == 0 || height == 0 {
                return Err("native capture has zero dimensions".to_owned());
            }
            let (stop, receiver) = mpsc::channel();
            let output_clone = output.clone();
            let worker = thread::Builder::new().name("hasgard-video".into()).spawn(move || {
                let start = Instant::now();
                let mut timestamps = vec![Duration::ZERO];
                let interval = Duration::from_nanos(1_000_000_000 / fps);
                let limit = Duration::from_millis(max_ms);
                while start.elapsed() < limit {
                    let next = (timestamps.last().expect("first frame exists").saturating_add(interval))
                        .saturating_sub(start.elapsed());
                    match receiver.recv_timeout(next.min(limit.saturating_sub(start.elapsed()))) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    if start.elapsed() >= limit { break; }
                    let path = dir.path().join(format!("frame-{:06}.png", timestamps.len()));
                    capture(id, &path)?;
                    timestamps.push(start.elapsed());
                }
                let elapsed = start.elapsed();
                let mut manifest = std::fs::File::create(dir.path().join("frames.txt")).map_err(|e| e.to_string())?;
                for (index, timestamp) in timestamps.iter().enumerate() {
                    let end = timestamps.get(index + 1).copied().unwrap_or(elapsed);
                    writeln!(manifest,"file 'frame-{index:06}.png'\nduration {:.6}",end.saturating_sub(*timestamp).as_secs_f64().max(0.001)).map_err(|e| e.to_string())?;
                }
                writeln!(manifest,"file 'frame-{:06}.png'", timestamps.len()-1).map_err(|e| e.to_string())?;
                drop(manifest);
                let encoded = dir.path().join("recording.mp4");
                encode(dir.path(), &encoded, width.div_ceil(2)*2, height.div_ceil(2)*2, fps)?;
                let bytes = std::fs::metadata(&encoded).map_err(|e| e.to_string())?.len();
                if bytes == 0 { return Err("encoder produced empty video".to_owned()); }
                // Same-filesystem hard link is atomic and refuses to overwrite a raced destination.
                std::fs::hard_link(&encoded, &output_clone).map_err(|e| format!("publish video: {e}"))?;
                Ok(json!({"output_path":output_clone,"frames":timestamps.len(),"duration_ms":elapsed.as_millis(),"byte_size":bytes,"window_id":id,"backend":"screencapture+ffmpeg"}))
            }).map_err(|e| e.to_string())?;
            sessions.insert(window.to_owned(), Session { stop, worker: Some(worker) });
            Ok(json!({"status":"recording","output_path":output,"window_id":id,"fps":fps,"max_duration_ms":max_ms}))
        }

        pub fn stop(&self, window: &str) -> Result<Value, String> {
            let mut session = self
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .remove(window)
                .ok_or_else(|| format!("window '{window}' has no video session"))?;
            let _ = session.stop.send(());
            session
                .worker
                .take()
                .ok_or("video worker missing")?
                .join()
                .map_err(|_| "video worker panicked".to_owned())?
        }

        pub fn status(&self, window: &str) -> Result<Value, String> {
            let sessions = self.0.lock().map_err(|e| e.to_string())?;
            let session = sessions.get(window);
            Ok(json!({"active":session.is_some_and(|s| s.worker.as_ref().is_some_and(|w| !w.is_finished())),
                "pending_result":session.is_some()}))
        }
    }

    fn integer(params: &Value, name: &str, default: u64, min: u64, max: u64) -> Result<u64, String> {
        match params.get(name) {
            None => Ok(default),
            Some(value) => value
                .as_u64()
                .filter(|v| (min..=max).contains(v))
                .ok_or_else(|| format!("{name} must be an integer in {min}..={max}")),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn video_validates_options_without_capturing() {
            let videos = Videos::default();
            assert!(videos.stop("main").is_err());
            assert_eq!(videos.status("main").expect("status")["active"], false);
            for params in [
                json!({}),
                json!({"output_path":"relative.mp4"}),
                json!({"output_path":"/tmp/x.png"}),
                json!({"output_path":"/tmp/x.mp4","fps":0}),
                json!({"output_path":"/tmp/x.mp4","max_duration_ms":null}),
            ] {
                assert!(videos.start("main", 1, &params).is_err());
            }
        }
        #[test]
        fn bounded_child_is_killed_and_reaped() {
            let start = Instant::now();
            assert!(run_bounded(Command::new("/bin/sleep").arg("10"), Duration::from_millis(30)).is_err());
            assert!(start.elapsed() < Duration::from_secs(2));
        }
        #[test]
        #[ignore = "requires ffmpeg; encodes generated PNGs, does not capture desktop"]
        fn real_encoder_produces_nonempty_mp4() {
            let dir = tempfile::tempdir().expect("temp");
            image::save_buffer(
                dir.path().join("frame-000000.png"),
                &[255; 16 * 16 * 4],
                16,
                16,
                image::ColorType::Rgba8,
            )
            .expect("png");
            std::fs::write(
                dir.path().join("frames.txt"),
                "file 'frame-000000.png'\nduration 0.2\nfile 'frame-000000.png'\n",
            )
            .expect("manifest");
            let output = dir.path().join("test.mp4");
            encode(dir.path(), &output, 16, 16, 5).expect("encode");
            assert!(std::fs::metadata(output).expect("video").len() > 0);
        }
    }
}
#[cfg(target_os = "macos")]
pub(crate) use macos::Videos;
