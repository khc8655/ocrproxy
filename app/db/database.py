"""数据库连接"""
import os
import time
import logging
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.core.config import settings

logger = logging.getLogger("db")


def _wait_for_mount(db_path: str, max_wait: int) -> None:
    """等待持久化卷挂载完成 — 魔搭 /mnt/workspace 可能延迟挂载

    检测策略: 每秒尝试创建父目录 + 写一个 .mount_probe 文件,
    成功就返回. 超时后仍失败则放弃等待, 继续往下走 (本地开发场景下
    DB_PATH 可能是 data/proxy.db, 父目录是相对路径直接 mkdir 即可).
    """
    parent = os.path.dirname(db_path) or "."

    # 本地开发: 路径不在 /mnt 下, 直接 mkdir 不等待
    if not parent.startswith("/mnt/"):
        os.makedirs(parent, exist_ok=True)
        return

    # 创空间: 等待平台挂载
    logger.info("Waiting for persistent volume to mount at %s (max %ds)...",
                parent, max_wait)
    deadline = time.time() + max_wait
    last_err = None
    while time.time() < deadline:
        try:
            os.makedirs(parent, exist_ok=True)
            probe = os.path.join(parent, ".mount_probe")
            with open(probe, "w") as f:
                f.write(str(time.time()))
            os.remove(probe)
            logger.info("Persistent volume ready at %s", parent)
            return
        except (OSError, PermissionError) as e:
            last_err = e
            time.sleep(1)
    # 超时: 不抛异常,容器仍能跑(数据会丢, 但服务可用)
    logger.warning(
        "Persistent volume not ready after %ds (last error: %s). "
        "Proceeding anyway — data may be lost on restart.",
        max_wait, last_err,
    )


# 启动时同步等待挂载 (lifespan 之外, 因为 engine 需要 DB_PATH 立即可用)
_wait_for_mount(settings.DB_PATH, settings.MOUNT_WAIT_SEC)

DATABASE_URL = f"sqlite:///{settings.DB_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False}, echo=False)


@event.listens_for(engine, "connect")
def _sqlite_pragma(dbapi_connection, _):
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    Base.metadata.create_all(bind=engine)
