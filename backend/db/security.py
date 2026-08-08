import base64
import hashlib
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from config import SECRET_KEY

# Derive a 256-bit (32-byte) key from the SECRET_KEY string
def _get_derived_key() -> bytes:
    return hashlib.sha256(SECRET_KEY.encode()).digest()

def encrypt_value(plain_text: str) -> str:
    """Encrypt a string using AES-256-GCM and base64-encode the result."""
    if not plain_text:
        return ""
    key = _get_derived_key()
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)  # 12-byte nonce for GCM
    encrypted_bytes = aesgcm.encrypt(nonce, plain_text.encode(), None)
    
    # Store the nonce and encrypted data together
    combined = nonce + encrypted_bytes
    return base64.b64encode(combined).decode("utf-8")

def decrypt_value(cipher_text: str) -> str:
    """Decrypt a base64-encoded string using AES-256-GCM."""
    if not cipher_text:
        return ""
    try:
        key = _get_derived_key()
        aesgcm = AESGCM(key)
        combined = base64.b64decode(cipher_text.encode("utf-8"))
        
        # Split nonce and cipher text
        nonce = combined[:12]
        encrypted_bytes = combined[12:]
        
        decrypted_bytes = aesgcm.decrypt(nonce, encrypted_bytes, None)
        return decrypted_bytes.decode("utf-8")
    except Exception as e:
        # Fallback if decryption fails (e.g. wrong key, modified database, or unencrypted data)
        print(f"[SECURITY ERROR] Decryption failed: {e}")
        return ""
