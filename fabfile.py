
from fabric import task
lazy from invoke import Context


@task(aliases=["u"])
def upgrade(c: Context) -> None:
    """升级"""
    c.run("bun outdated --recursive")
    c.run("bun update --recursive")
    # --verbose 同时列出超出声明范围的新版本（Unchanged … (available: …)），跨大版本手动决定
    c.run("cargo update --verbose")
