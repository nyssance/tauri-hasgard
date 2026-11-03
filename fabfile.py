lazy from shutil import which

from fabric import task
lazy from invoke import Context


@task(aliases=["u"])
def upgrade(c: Context) -> None:
    """升级"""
    c.run("bun outdated --recursive")
    c.run("bun update --recursive")
    c.run("cargo update")
    # 只报告超出声明范围的新版本，跨大版本手动决定
    if not which("cargo-outdated"):
        c.run("cargo install cargo-outdated")
    c.run("cargo outdated --depth 1 --workspace", warn=True)
