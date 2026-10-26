"""Local development tasks for the Hasgard workspace."""

from fabric import task
from invoke import Context


@task(aliases=["u"])
def upgrade(c: Context) -> None:
    """Upgrade every workspace's dependencies to the latest versions."""
    c.run("bun update --latest --recursive", echo=True)
    c.run("cargo upgrade --incompatible", echo=True)
    c.run("cargo update", echo=True)
