(function () {
  const NOTE_CATEGORIES = ['Geral', 'Chamados', 'Acessos'];
  const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'lavender'];
  const DEFAULT_SIZE = { width: 430, height: 490 };

  class PersonalNotesManager {
    constructor() {
      this.drawer = document.getElementById('personal-notes-drawer');
      this.fab = document.getElementById('personal-notes-fab');
      this.tip = document.getElementById('personal-notes-tip');
      this.backdrop = document.getElementById('personal-notes-backdrop');
      this.content = document.getElementById('personal-notes-content');
      this.title = document.getElementById('personal-notes-title');
      this.select = document.getElementById('personal-notes-select');
      this.color = document.getElementById('personal-notes-color');
      this.status = document.getElementById('personal-notes-save-status');
      this.count = document.getElementById('personal-notes-char-count');
      this.body = this.drawer?.querySelector('.personal-notes-body');
      this.notes = [];
      this.currentNoteId = null;
      this.activeCategory = 'Geral';
      this.saveTimer = null;
      this.saveInProgress = false;
      this.opened = false;
      this.privateMode = false;
      this.resizeObserver = null;
      this.noteHistory = new Map();
      this.activeHistory = null;
      this.pendingEditorSnapshot = null;
      this.persistedState = this.readPersistentState();
      this.isPinned = this.persistedState.pinned;
      if (!this.drawer || !this.fab || !this.content || !this.title || !this.select) return;
      this.bindEvents();
      this.restoreSize();
      this.syncPinButton();
      this.showFirstUseTip();
      void this.loadNotes();
      if (this.isPinned) {
        this.open();
        if (this.persistedState.minimized) this.toggleMinimized();
      }
    }

    bindEvents() {
      if (!this.drawer || !this.fab) return;
      this.fab.addEventListener('click', () => {
        this.dismissTip();
        this.open();
      });
      document.getElementById('personal-notes-tip-dismiss')?.addEventListener('click', () => this.dismissTip());
      document.getElementById('personal-notes-pin')?.addEventListener('click', () => this.togglePin());
      document.getElementById('personal-notes-close')?.addEventListener('click', () => this.close());
      document.getElementById('personal-notes-minimize')?.addEventListener('click', () => this.toggleMinimized());
      document.getElementById('personal-notes-privacy')?.addEventListener('click', event => this.togglePrivacy(event.currentTarget));
      document.getElementById('personal-notes-new')?.addEventListener('click', () => void this.createNote());
      document.getElementById('personal-notes-save')?.addEventListener('click', () => void this.saveCurrentNote(true));
      document.getElementById('personal-notes-delete')?.addEventListener('click', () => void this.deleteCurrentNote());
      document.getElementById('personal-notes-settings-toggle')?.addEventListener('click', event => {
        const settings = document.getElementById('personal-notes-settings');
        const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true';
        event.currentTarget.setAttribute('aria-expanded', String(!expanded));
        settings.hidden = expanded;
      });
      document.getElementById('personal-notes-reset-size')?.addEventListener('click', () => this.resetSize());
      this.backdrop?.addEventListener('click', () => {
        if (!this.isPinned) this.close();
      });
      this.content?.addEventListener('input', event => this.onEditorInput(event));
      this.content?.addEventListener('beforeinput', () => {
        this.pendingEditorSnapshot = this.content.innerHTML;
      });
      this.content?.addEventListener('paste', event => this.pastePlainText(event));
      this.title?.addEventListener('input', () => this.onEditorInput());
      this.select?.addEventListener('change', () => void this.selectNote(this.select.value));
      this.color?.addEventListener('change', () => {
        this.applyColor(this.color.value);
        this.scheduleSave();
      });
      document.querySelectorAll('[data-note-category]').forEach(button => {
        button.addEventListener('click', () => void this.changeCategory(button.dataset.noteCategory));
      });
      document.querySelectorAll('[data-note-format]').forEach(button => {
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => this.applyFormat(button.dataset.noteFormat));
      });
      document.querySelectorAll('[data-note-history]').forEach(button => {
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => void this.applyHistory(button.dataset.noteHistory));
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && this.opened && !this.isPinned) this.close();
      });
      this.content.addEventListener('keydown', event => {
        if (!(event.ctrlKey || event.metaKey)) return;
        const shortcut = event.key.toLowerCase();
        if (shortcut === 'z' || shortcut === 'y') {
          event.preventDefault();
          void this.applyHistory(shortcut === 'y' || event.shiftKey ? 'redo' : 'undo');
          return;
        }
        const format = shortcut === 'b' ? 'bold' : shortcut === 'i' ? 'italic'
          : shortcut === '8' && event.shiftKey ? 'list' : null;
        if (!format) return;
        event.preventDefault();
        this.applyFormat(format);
      });
      this.drawer.addEventListener('transitionend', () => {
        if (this.opened) this.content?.focus({ preventScroll: true });
      });
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(entries => {
          const rect = entries[0]?.contentRect;
          if (!rect || rect.width < 300 || rect.height < 280) return;
          clearTimeout(this.resizeTimer);
          this.resizeTimer = setTimeout(() => {
            localStorage.setItem(this.sizeStorageKey(), JSON.stringify({ width: Math.round(rect.width), height: Math.round(rect.height) }));
          }, 250);
        });
        this.resizeObserver.observe(this.drawer);
      }
    }

    sizeStorageKey() {
      const userKey = window.currentUserProfile?.id || window.currentUserProfile?.username || 'user';
      return `portal.personal-notes.size.${userKey}`;
    }

    stateStorageKey() {
      const userKey = window.currentUserProfile?.id || window.currentUserProfile?.username || 'user';
      return `portal.personal-notes.state.${userKey}`;
    }

    tipStorageKey() {
      const userKey = window.currentUserProfile?.id || window.currentUserProfile?.username || 'user';
      return `portal.personal-notes.tip-dismissed.${userKey}`;
    }

    showFirstUseTip() {
      if (!this.tip || localStorage.getItem(this.tipStorageKey()) === 'true') return;
      this.tip.hidden = false;
    }

    dismissTip() {
      if (!this.tip || this.tip.hidden) return;
      this.tip.hidden = true;
      localStorage.setItem(this.tipStorageKey(), 'true');
    }

    readPersistentState() {
      try {
        const state = JSON.parse(localStorage.getItem(this.stateStorageKey()) || '{}');
        return { pinned: state.pinned === true, minimized: state.minimized === true };
      } catch (error) {
        return { pinned: false, minimized: false };
      }
    }

    persistState() {
      localStorage.setItem(this.stateStorageKey(), JSON.stringify({
        pinned: this.isPinned,
        minimized: this.drawer.classList.contains('is-minimized')
      }));
    }

    syncPinButton() {
      const button = document.getElementById('personal-notes-pin');
      button?.classList.toggle('is-pinned', this.isPinned);
      button?.setAttribute('aria-pressed', String(this.isPinned));
      button?.setAttribute('aria-label', this.isPinned ? 'Desafixar bloco de notas' : 'Fixar bloco de notas aberto');
      if (button) button.title = this.isPinned ? 'Bloco fixado — clique para desafixar' : 'Fixar aberto após atualizar';
      document.getElementById('personal-notes-widget')?.classList.toggle('is-pinned', this.isPinned);
    }

    togglePin() {
      this.isPinned = !this.isPinned;
      if (this.isPinned) this.open();
      else if (this.drawer.classList.contains('is-minimized')) this.toggleMinimized();
      this.syncPinButton();
      this.persistState();
      this.setStatus(this.isPinned ? 'Bloco fixado: continuará aberto após atualizar.' : 'Bloco desafixado.');
    }

    restoreSize() {
      try {
        const saved = JSON.parse(localStorage.getItem(this.sizeStorageKey()) || 'null');
        if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
          this.drawer.style.width = `${Math.max(320, Math.min(saved.width, window.innerWidth - 24))}px`;
          this.drawer.style.height = `${Math.max(300, Math.min(saved.height, window.innerHeight - 90))}px`;
        }
      } catch (error) {
        this.resetSize();
      }
    }

    resetSize() {
      localStorage.removeItem(this.sizeStorageKey());
      this.drawer.style.width = '';
      this.drawer.style.height = '';
    }

    async loadNotes() {
      this.setStatus('Carregando notas...');
      try {
        this.notes = await apiRequest('/api/notes', 'GET', null, true);
        if (!Array.isArray(this.notes)) this.notes = [];
        const firstNote = this.notes.find(note => note.category === this.activeCategory);
        this.renderNote(firstNote || null);
        this.setStatus(this.notes.length ? 'Notas sincronizadas.' : 'Crie sua primeira nota.');
      } catch (error) {
        this.setStatus('Não foi possível sincronizar. Tente novamente.');
      }
    }

    open() {
      this.opened = true;
      this.drawer.hidden = false;
      this.backdrop.hidden = false;
      this.drawer.setAttribute('aria-hidden', 'false');
      this.fab.setAttribute('aria-expanded', 'true');
      this.drawer.classList.remove('is-minimized');
      this.persistState();
      requestAnimationFrame(() => this.drawer.classList.add('is-open'));
      this.fab.setAttribute('aria-label', 'Bloco de notas aberto');
    }

    close() {
      if (!this.opened) return;
      void this.saveCurrentNote(false);
      this.isPinned = false;
      this.syncPinButton();
      this.persistState();
      this.opened = false;
      this.drawer.classList.remove('is-open');
      this.drawer.setAttribute('aria-hidden', 'true');
      this.backdrop.hidden = true;
      this.fab.setAttribute('aria-expanded', 'false');
      this.fab.setAttribute('aria-label', 'Abrir bloco de notas');
      this.privateMode = false;
      this.body?.classList.remove('is-private');
      const privacyButton = document.getElementById('personal-notes-privacy');
      privacyButton?.setAttribute('aria-pressed', 'false');
      if (privacyButton) privacyButton.innerHTML = '<i class="fa-regular fa-eye" aria-hidden="true"></i>';
      setTimeout(() => { if (!this.opened) this.drawer.hidden = true; }, 220);
      this.fab.focus();
    }

    toggleMinimized() {
      const minimized = this.drawer.classList.toggle('is-minimized');
      if (minimized) void this.saveCurrentNote(false);
      this.persistState();
      const button = document.getElementById('personal-notes-minimize');
      button?.setAttribute('aria-label', minimized ? 'Restaurar bloco de notas' : 'Minimizar bloco de notas');
      if (!minimized) this.drawer.style.height = localStorage.getItem(this.sizeStorageKey()) ? this.drawer.style.height : '';
    }

    togglePrivacy(button) {
      this.privateMode = !this.privateMode;
      this.body?.classList.toggle('is-private', this.privateMode);
      this.drawer.classList.toggle('is-private', this.privateMode);
      button.setAttribute('aria-pressed', String(this.privateMode));
      button.setAttribute('aria-label', this.privateMode ? 'Mostrar conteúdo da nota' : 'Ocultar conteúdo da nota');
      button.title = this.privateMode ? 'Mostrar conteúdo' : 'Ocultar conteúdo';
      button.innerHTML = `<i class="fa-regular ${this.privateMode ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i>`;
    }

    currentCategoryNotes() {
      return this.notes.filter(note => note.category === this.activeCategory);
    }

    renderNote(note) {
      this.currentNoteId = note ? String(note.id) : null;
      this.select.replaceChildren();
      const categoryNotes = this.currentCategoryNotes();
      if (!categoryNotes.length) {
        const empty = new Option('Nenhuma nota', '');
        this.select.add(empty);
        this.select.disabled = true;
      } else {
        categoryNotes.forEach(item => this.select.add(new Option(item.title || 'Nova nota', String(item.id))));
        this.select.disabled = false;
        if (note) this.select.value = String(note.id);
      }
      this.title.value = note?.title || '';
      this.content.innerHTML = this.sanitizeNoteHtml(note?.content || '');
      this.activeHistory = this.getHistory(note ? `note:${note.id}` : `draft:${this.activeCategory}`);
      this.activeHistory.lastHtml = this.content.innerHTML;
      this.pendingEditorSnapshot = null;
      this.updateHistoryButtons();
      this.updateCharacterCount();
      document.getElementById('personal-notes-delete').disabled = !note;
    }

    async selectNote(noteId) {
      if (this.currentNoteId === String(noteId)) return;
      await this.saveCurrentNote(false);
      const next = this.notes.find(note => String(note.id) === String(noteId));
      this.renderNote(next || null);
    }

    async changeCategory(category) {
      if (!NOTE_CATEGORIES.includes(category) || category === this.activeCategory) return;
      await this.saveCurrentNote(false);
      this.activeCategory = category;
      document.querySelectorAll('[data-note-category]').forEach(button => {
        const selected = button.dataset.noteCategory === category;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      this.renderNote(this.currentCategoryNotes()[0] || null);
    }

    async createNote() {
      await this.saveCurrentNote(false);
      this.setStatus('Criando nota...');
      try {
        const note = await apiRequest('/api/notes', 'POST', {
          title: 'Nova nota', category: this.activeCategory, content: '', color: this.color.value || 'yellow'
        }, true);
        this.notes.unshift(note);
        this.renderNote(note);
        this.title.focus();
        this.setStatus('Nota criada. Salvamento automático ativado.');
      } catch (error) {
        this.setStatus(error.message || 'Não foi possível criar a nota.');
      }
    }

    async deleteCurrentNote() {
      if (!this.currentNoteId) return;
      if (!window.confirm('Excluir esta nota? Esta ação não pode ser desfeita.')) return;
      clearTimeout(this.saveTimer);
      const noteId = this.currentNoteId;
      try {
        await apiRequest(`/api/notes/${encodeURIComponent(noteId)}`, 'DELETE', null, true);
        this.notes = this.notes.filter(note => String(note.id) !== noteId);
        this.renderNote(this.currentCategoryNotes()[0] || null);
        this.setStatus('Nota excluída.');
      } catch (error) {
        this.setStatus(error.message || 'Não foi possível excluir a nota.');
      }
    }

    onEditorInput(event) {
      const history = this.activeHistory || this.getHistory(this.currentNoteId ? `note:${this.currentNoteId}` : `draft:${this.activeCategory}`);
      const inputType = event?.inputType || '';
      if (inputType !== 'historyUndo' && inputType !== 'historyRedo') {
        const previousHtml = this.pendingEditorSnapshot ?? history.lastHtml;
        const isTyping = /^(insertText|insertCompositionText|deleteContentBackward|deleteContentForward|insertParagraph|insertLineBreak)/.test(inputType);
        if (previousHtml !== this.content.innerHTML && (!isTyping || !history.typingGroupActive)) {
          history.undo.push(previousHtml);
          if (history.undo.length > 100) history.undo.shift();
          history.redo = [];
        }
        if (isTyping) {
          history.typingGroupActive = true;
          clearTimeout(history.typingTimer);
          history.typingTimer = setTimeout(() => {
            history.typingGroupActive = false;
            this.updateHistoryButtons();
          }, 700);
        } else {
          history.typingGroupActive = false;
          clearTimeout(history.typingTimer);
        }
      }
      history.lastHtml = this.content.innerHTML;
      this.pendingEditorSnapshot = null;
      this.updateHistoryButtons();
      this.updateCharacterCount();
      this.scheduleSave();
    }

    getHistory(key) {
      if (!this.noteHistory.has(key)) this.noteHistory.set(key, { undo: [], redo: [], lastHtml: '', typingGroupActive: false, typingTimer: null });
      return this.noteHistory.get(key);
    }

    updateHistoryButtons() {
      const history = this.activeHistory;
      document.querySelector('[data-note-history="undo"]')?.toggleAttribute('disabled', !history?.undo.length);
      document.querySelector('[data-note-history="redo"]')?.toggleAttribute('disabled', !history?.redo.length);
    }

    async applyHistory(action) {
      const history = this.activeHistory;
      if (!history) return;
      clearTimeout(history.typingTimer);
      history.typingGroupActive = false;
      const source = action === 'undo' ? history.undo : history.redo;
      const destination = action === 'undo' ? history.redo : history.undo;
      const snapshot = source.pop();
      if (snapshot === undefined) return;
      destination.push(this.content.innerHTML);
      this.content.innerHTML = snapshot;
      history.lastHtml = snapshot;
      this.pendingEditorSnapshot = null;
      this.content.focus();
      const selection = document.createRange();
      selection.selectNodeContents(this.content);
      selection.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(selection);
      this.updateHistoryButtons();
      this.updateCharacterCount();
      await this.saveCurrentNote(false);
    }

    async saveCurrentNote(showConfirmation) {
      clearTimeout(this.saveTimer);
      if (this.saveInProgress) {
        await new Promise(resolve => setTimeout(resolve, 150));
        return this.saveCurrentNote(showConfirmation);
      }
      if (!this.currentNoteId) {
        if (!this.title.value.trim() && !this.editorText().trim()) return;
        try {
          const note = await apiRequest('/api/notes', 'POST', this.getPayload(), true);
          this.notes.unshift(note);
          this.renderNote(note);
          this.setStatus('Nota salva automaticamente.');
          return note;
        } catch (error) {
          this.setStatus(error.message || 'Falha ao salvar.');
          return;
        }
      }
      const noteId = this.currentNoteId;
      const payload = this.getPayload();
      this.saveInProgress = true;
      this.setStatus('Salvando...');
      try {
        const updated = await apiRequest(`/api/notes/${encodeURIComponent(noteId)}`, 'PUT', payload, true);
        this.notes = this.notes.map(note => String(note.id) === noteId ? updated : note);
        this.updateNotePicker(updated);
        this.setStatus(`Salvo automaticamente às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`);
        return updated;
      } catch (error) {
        this.setStatus(error.message || 'Falha ao salvar.');
      } finally {
        this.saveInProgress = false;
      }
    }

    getPayload() {
      return {
        title: this.title.value.trim() || 'Nova nota',
        category: this.activeCategory,
        content: this.sanitizeNoteHtml(this.content.innerHTML),
        color: this.color.value
      };
    }

    updateNotePicker(updated) {
      const option = Array.from(this.select.options).find(item => item.value === String(updated.id));
      if (option) option.textContent = updated.title || 'Nova nota';
    }

    applyColor(color) {
      const safeColor = NOTE_COLORS.includes(color) ? color : 'yellow';
      this.drawer.classList.remove(...NOTE_COLORS.map(name => `note-color-${name}`));
      this.drawer.classList.add(`note-color-${safeColor}`);
    }

    applyFormat(format) {
      this.content.focus();
      const command = { bold: 'bold', italic: 'italic', list: 'insertUnorderedList' }[format];
      if (!command) return;
      document.execCommand(command, false);
      this.onEditorInput();
    }

    editorText() {
      return (this.content.innerText || this.content.textContent || '').replace(/\u00a0/g, ' ');
    }

    editorTextFromHtml(html) {
      const temporary = document.createElement('div');
      temporary.innerHTML = html;
      return temporary.textContent || '';
    }

    pastePlainText(event) {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain');
      if (typeof text !== 'string') return;
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const fragment = document.createDocumentFragment();
      lines.forEach((line, index) => {
        if (line) fragment.appendChild(document.createTextNode(line));
        if (index < lines.length - 1) fragment.appendChild(document.createElement('br'));
      });
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!this.content.contains(range.commonAncestorContainer)) return;
      this.pendingEditorSnapshot = this.content.innerHTML;
      range.deleteContents();
      range.insertNode(fragment);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      this.onEditorInput();
    }

    sanitizeNoteHtml(value) {
      const input = String(value || '');
      if (!/<[a-z][\s\S]*>/i.test(input)) {
        const escaped = document.createElement('div');
        const lines = input.replace(/\r\n?/g, '\n').split('\n');
        lines.forEach((line, index) => {
          if (line) escaped.appendChild(document.createTextNode(line));
          if (index < lines.length - 1) escaped.appendChild(document.createElement('br'));
        });
        return escaped.innerHTML;
      }

      const parsed = new DOMParser().parseFromString(input, 'text/html');
      const allowedTags = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'DIV', 'UL', 'OL', 'LI']);
      const cleanChildren = (source, target) => {
        Array.from(source.childNodes).forEach(node => {
          if (node.nodeType === Node.TEXT_NODE) {
            target.appendChild(document.createTextNode(node.nodeValue || ''));
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = node.tagName.toUpperCase();
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT') return;
          if (!allowedTags.has(tag)) {
            cleanChildren(node, target);
            return;
          }
          const safeElement = document.createElement(tag.toLowerCase());
          cleanChildren(node, safeElement);
          target.appendChild(safeElement);
        });
      };
      const safe = document.createElement('div');
      cleanChildren(parsed.body, safe);
      return safe.innerHTML;
    }

    setStatus(message) {
      if (this.status) this.status.textContent = message;
    }
  }

  window.PersonalNotesManager = PersonalNotesManager;
})();
