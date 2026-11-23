from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
import models

async def get_user_by_username(db: AsyncSession, username: str):
    """
    Busca um usuário pelo nome de usuário no banco de dados.
    """
    result = await db.execute(select(models.User).filter(models.User.username == username))
    return result.scalars().first()