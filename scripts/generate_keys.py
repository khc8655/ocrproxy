# 生成加密密钥 (用于加密数据库中存储的上游 API Key)
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# 生成一个随机字符串作为 PROXY_API_KEY (agent 调用时带)
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
