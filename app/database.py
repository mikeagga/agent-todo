import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.config import settings


# Ensure data directory exists for SQLite
db_path = settings.database_url.replace("sqlite:///", "")
os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)

engine = create_engine(settings.database_url, echo=False)
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


def init_db():
    """Create all tables."""
    from app.models import Todo, Reminder, Idea, ChangeLog  # noqa: F401
    Base.metadata.create_all(bind=engine)


def get_db():
    """Yield a DB session (for use in services)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
