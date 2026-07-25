"""Run: python -m backend  (from repo root)."""

import uvicorn

from . import config

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
    )
