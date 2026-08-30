import uvicorn

from .main import build_app


def main() -> None:
    uvicorn.run(
        build_app(),
        host="127.0.0.1",
        port=8788,
        workers=1,
    )


if __name__ == "__main__":
    main()
