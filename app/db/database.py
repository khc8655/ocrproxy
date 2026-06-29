"""数据库连接"""
import os
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.core.config import settings

DATABASE_URL = f"sqlite:///{settings.DB_PATH}"

# 确保数据目录存在
os.makedirs(os.path.dirname(settings.DB_PATH) or ".", exist_ok=True)

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
