"""加密助手 — 用 Fernet 对称加密存储上游 Key"""
from cryptography.fernet import Fernet
from app.core.config import settings


def encrypt_key(plaintext: str) -> str:
    if not plaintext:
        return ""
    return settings.fernet.encrypt(plaintext.encode()).decode()


def decrypt_key(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    try:
        return settings.fernet.decrypt(ciphertext.encode()).decode()
    except Exception:
        return ""  # 密钥换了/解密失败 → 当作空 Key，会被调度跳过


def mask_key(plaintext: str) -> str:
    if not plaintext:
        return ""
    if len(plaintext) <= 10:
        return plaintext[:2] + "****"
    return plaintext[:6] + "****" + plaintext[-4:]
