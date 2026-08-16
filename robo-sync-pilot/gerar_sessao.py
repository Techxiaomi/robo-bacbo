from playwright.sync_api import sync_playwright
from env_loader import load_env_file
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
load_env_file(os.path.join(PROJECT_ROOT, ".env"))

def gerar_sessao():
    with sync_playwright() as p:
        print("🚀 Abrindo navegador para login manual...")
        
        # Inicia o navegador visível
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        # =================================================================
        # URL da página inicial da casa de apostas para realizar o login
        url_login = os.getenv("CASINO_HOME_URL", "")
        # =================================================================
        
        page.goto(url_login)

        print("\n=======================================================")
        print("⏳ Faça o login e resolva o Captcha na janela que abriu.")
        print("⚠️ Navegue até a página inicial da sua conta logada.")
        print("=======================================================\n")
        
        # O robô pausa aqui e só continua quando você der ENTER no terminal
        input("👉 Pressione [ENTER] AQUI NO TERMINAL quando estiver logado com sucesso...")

        print("✅ Salvando a sua sessão...")
        # Salva o "crachá de acesso" no arquivo JSON
        context.storage_state(path=os.getenv("SESSION_STATE_FILE", os.path.join(BASE_DIR, "sessao_salva.json")))
        
        browser.close()
        print("📁 Sessão salva no arquivo 'sessao_salva.json'.")
        print("Você já pode fechar esse script e rodar o robo.py!")

if __name__ == "__main__":
    gerar_sessao()