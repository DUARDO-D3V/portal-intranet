const LEGAL_CONTENT = {
  privacidade: {
    title: 'Política de privacidade',
    html: '<p>O portal processa os dados necessários para autenticação, controle de acesso e funcionamento dos recursos internos.</p><p>Dados como nome, usuário, e-mail, telefone, cargo, perfil e atividades podem ser armazenados no banco configurado pela organização.</p><p><a href="/politica-privacidade.html">Ler a política completa</a>.</p>'
  },
  termos: {
    title: 'Termos de uso',
    html: '<p>O acesso é autorizado apenas para fins profissionais internos e contas individuais.</p><p>Credenciais não devem ser compartilhadas. Conteúdos publicados devem estar autorizados e compatíveis com a política interna da organização.</p><p><a href="/termos-de-uso.html">Ler os termos completos</a>.</p>'
  },
  cookies: {
    title: 'Aviso de cookies',
    html: '<p>Este portal usa somente cookies essenciais para manter sessão e autenticação. Preferências locais podem ser armazenadas no navegador.</p><p>Não usamos publicidade ou rastreamento opcional por padrão.</p>'
  },
  acessibilidade: {
    title: 'Acessibilidade',
    html: '<p>Buscamos oferecer navegação por teclado, leitores de tela, contraste, tema escuro e foco visível.</p><p>Para relatar uma dificuldade, entre em contato com o administrador do portal.</p><p><a href="/acessibilidade.html">Conhecer o compromisso de acessibilidade</a>.</p>'
  }
};

async function initializeLegalFooter() {
  const placeholder = document.getElementById('site-footer-placeholder');
  if (placeholder && placeholder.childElementCount === 0) {
    try {
      const response = await fetch('/components/legal-footer.html');
      if (!response.ok) throw new Error('Não foi possível carregar o rodapé.');
      placeholder.innerHTML = await response.text();
    } catch (error) {
      console.error(error);
    }
  }

  const backdrop = document.getElementById('legal-dialog-backdrop');
  const title = document.getElementById('legal-dialog-title');
  const content = document.getElementById('legal-dialog-content');
  const closeButton = document.getElementById('legal-dialog-close');
  let lastFocusedElement = null;

  function closeDialog() {
    if (!backdrop) return;
    backdrop.hidden = true;
    document.body.classList.remove('legal-dialog-open');
    lastFocusedElement?.focus();
  }

  document.querySelectorAll('[data-legal-dialog]').forEach(button => {
    button.addEventListener('click', () => {
      const item = LEGAL_CONTENT[button.dataset.legalDialog];
      if (!item || !backdrop || !title || !content) return;
      lastFocusedElement = document.activeElement;
      title.textContent = item.title;
      content.innerHTML = item.html;
      backdrop.hidden = false;
      document.body.classList.add('legal-dialog-open');
      closeButton?.focus();
    });
  });

  closeButton?.addEventListener('click', closeDialog);
  backdrop?.addEventListener('click', event => {
    if (event.target === backdrop) closeDialog();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && backdrop && !backdrop.hidden) closeDialog();
  });

  const cookieBanner = document.getElementById('cookie-banner');
  const cookieAccept = document.getElementById('cookie-banner-accept');
  if (cookieBanner && !localStorage.getItem('portal-cookie-notice-read')) {
    cookieBanner.hidden = false;
  }
  cookieAccept?.addEventListener('click', () => {
    localStorage.setItem('portal-cookie-notice-read', 'true');
    cookieBanner.hidden = true;
  });
}

document.addEventListener('DOMContentLoaded', initializeLegalFooter);
