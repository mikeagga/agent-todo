from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Telegram
    telegram_bot_token: str = ""
    webhook_url: str = ""  # e.g. https://your-app.railway.app/webhook

    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    # Database
    database_url: str = "sqlite:///data/todos.db"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
