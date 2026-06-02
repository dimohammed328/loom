"""Entry point: `python -m loom_web` starts the uvicorn dev server."""

import uvicorn


def main() -> None:
    uvicorn.run("loom_web.app:create_app", factory=True, reload=True)


if __name__ == "__main__":
    main()
