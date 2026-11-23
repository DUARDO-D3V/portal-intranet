document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const rememberMeInput = document.getElementById('rememberMe');
    const loginMessage = document.getElementById('loginMessage');
    const forgotPasswordLink = document.querySelector('.remember-forgot a');
    const modal = document.getElementById('forgot-password-modal');
    const closeModalBtn = document.getElementById('close-modal');

    if (forgotPasswordLink) {
        forgotPasswordLink.addEventListener('click', (e) => {
            e.preventDefault();
            modal.style.display = 'flex';
        });
    }

    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }

    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const username = usernameInput.value.trim();
            const password = passwordInput.value.trim();
            loginMessage.textContent = '';

            if (!username || !password) {
                loginMessage.textContent = 'Por favor, preencha todos os campos.';
                loginMessage.style.color = 'red';
                return;
            }

            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        username,
                        password,
                        rememberMe: rememberMeInput.checked,
                    }),
                });
                const data = await response.json();
                if (response.ok) {
                    loginMessage.textContent = 'Login bem-sucedido! Redirecionando...';
                    loginMessage.style.color = 'green';
                    window.location.href = '/portal.html';
                } else {
                    loginMessage.textContent = data.message || 'Usuário ou senha inválidos.';
                    loginMessage.style.color = 'red';
                }
            } catch (error) {
                console.error('Erro ao tentar fazer login:', error);
                loginMessage.textContent = 'Não foi possível conectar ao servidor. Tente novamente.';
                loginMessage.style.color = 'red';
            }
        });
    }

    if (usernameInput) {
      usernameInput.addEventListener('input', () => { loginMessage.textContent = ''; });
    }
    if (passwordInput) {
      passwordInput.addEventListener('input', () => { loginMessage.textContent = ''; });
    }
});