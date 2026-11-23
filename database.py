import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base

# Pega a URL do banco de dados do arquivo .env
DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise ValueError("DATABASE_URL não foi definida no arquivo .env")

# Cria o motor de conexão com o banco de dados
engine = create_async_engine(DATABASE_URL)

# Cria uma fábrica de sessões assíncronas
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
    class_=AsyncSession
)

# Base para os nossos modelos ORM (tabelas)
Base = declarative_base()

# Função (dependência) para obter uma sessão do banco de dados em cada requisição
async def get_db():
    async with SessionLocal() as session:
        yield session