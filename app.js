(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  const state = {
    data: null,
    visibleItems: [],
    currentId: '',
    fileHandle: null
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char]));
  }

  function normalizeData(payload) {
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error('JSON không có mảng items hợp lệ.');
    }

    const next = clone(payload);
    next.schema_version = next.schema_version || 1;
    next.export_type = next.export_type || 'communication_dialogue_review';

    next.items = next.items.map((item, index) => ({
      ...item,
      dialogue_id: String(item.dialogue_id || `dialogue_${index + 1}`),
      verified: Boolean(item.verified),
      verified_at: item.verified ? (item.verified_at || null) : null,
      turns: Array.isArray(item.turns) ? item.turns : []
    }));

    recalcSummary(next);
    return next;
  }

  function recalcSummary(target = state.data) {
    if (!target) return;
    const dialogues = target.items.length;
    const verified = target.items.filter(item => item.verified).length;
    target.summary = {
      dialogues,
      verified,
      unverified: dialogues - verified
    };
  }

  function itemLabel(item) {
    return item.activity_title || item.activity_key || item.dialogue_id;
  }

  function uniqueBy(items, keyFn) {
    const seen = new Map();
    items.forEach(item => {
      const key = keyFn(item);
      if (!seen.has(key)) seen.set(key, item);
    });
    return [...seen.values()];
  }

  function option(value, label) {
    return `<option value="${esc(value)}">${esc(label)}</option>`;
  }

  function fillFilters({ resetLesson = false, resetActivity = false } = {}) {
    if (!state.data) return;

    const moduleNode = $('moduleFilter');
    const lessonNode = $('lessonFilter');
    const activityNode = $('activityFilter');

    const modules = uniqueBy(state.data.items, item => item.module_key || item.module_title || '');
    const oldModule = moduleNode.value;
    moduleNode.innerHTML = option('all', 'Tất cả module') + modules.map(item =>
      option(item.module_key || item.module_title, `${item.module_title || item.module_key}`)
    ).join('');

    if (oldModule && [...moduleNode.options].some(o => o.value === oldModule)) {
      moduleNode.value = oldModule;
    }

    const moduleValue = moduleNode.value;
    const lessonPool = state.data.items.filter(item =>
      moduleValue === 'all' || (item.module_key || item.module_title) === moduleValue
    );

    const lessons = uniqueBy(lessonPool, item => item.lesson_key || item.lesson_title || '');
    const oldLesson = resetLesson ? '' : lessonNode.value;
    lessonNode.innerHTML = option('all', 'Tất cả lesson') + lessons.map(item =>
      option(item.lesson_key || item.lesson_title, `${item.lesson_key} · ${item.lesson_title}`)
    ).join('');

    if (oldLesson && [...lessonNode.options].some(o => o.value === oldLesson)) {
      lessonNode.value = oldLesson;
    }

    const lessonValue = lessonNode.value;
    const activityPool = lessonPool.filter(item =>
      lessonValue === 'all' || (item.lesson_key || item.lesson_title) === lessonValue
    );

    const oldActivity = resetActivity ? '' : activityNode.value;
    activityNode.innerHTML = option('all', 'Tất cả activity') + activityPool.map(item =>
      option(item.dialogue_id, `${item.activity_key} · ${item.activity_title}`)
    ).join('');

    if (oldActivity && [...activityNode.options].some(o => o.value === oldActivity)) {
      activityNode.value = oldActivity;
    }
  }

  function rebuildVisible({ preserveCurrent = true } = {}) {
    if (!state.data) {
      state.visibleItems = [];
      render();
      return;
    }

    const moduleValue = $('moduleFilter').value;
    const lessonValue = $('lessonFilter').value;
    const activityValue = $('activityFilter').value;
    const statusValue = $('statusFilter').value;

    state.visibleItems = state.data.items.filter(item => {
      if (moduleValue !== 'all' && (item.module_key || item.module_title) !== moduleValue) return false;
      if (lessonValue !== 'all' && (item.lesson_key || item.lesson_title) !== lessonValue) return false;
      if (activityValue !== 'all' && item.dialogue_id !== activityValue) return false;
      if (statusValue === 'verified' && !item.verified) return false;
      if (statusValue === 'unverified' && item.verified) return false;
      return true;
    });

    if (
      !preserveCurrent ||
      !state.visibleItems.some(item => item.dialogue_id === state.currentId)
    ) {
      state.currentId = state.visibleItems[0]?.dialogue_id || '';
    }

    render();
  }

  function currentIndex() {
    return state.visibleItems.findIndex(item => item.dialogue_id === state.currentId);
  }

  function currentItem() {
    const index = currentIndex();
    return index >= 0 ? state.visibleItems[index] : null;
  }

  function move(delta) {
    const index = currentIndex();
    if (index < 0) return;
    const next = index + delta;
    if (next < 0 || next >= state.visibleItems.length) return;
    state.currentId = state.visibleItems[next].dialogue_id;
    render();
  }

  function renderSummary() {
    if (!state.data) return;
    recalcSummary();
    const summary = state.data.summary;
    $('verifiedCount').textContent = summary.verified;
    $('unverifiedCount').textContent = summary.unverified;
    $('totalCount').textContent = summary.dialogues;
    $('summaryProgress').style.width = summary.dialogues
      ? `${Math.round(summary.verified / summary.dialogues * 100)}%`
      : '0%';
  }

  function render() {
    renderSummary();

    const item = currentItem();
    const list = $('dialogueList');

    if (!item) {
      $('breadcrumb').textContent = '—';
      $('activityTitle').textContent = 'Không có hội thoại trong phạm vi đang chọn';
      $('activityMeta').textContent = '—';
      $('positionText').textContent = `0 / ${state.visibleItems.length}`;
      list.innerHTML = '<div class="empty">Không có dữ liệu phù hợp.</div>';
      $('prevBtn').disabled = true;
      $('nextBtn').disabled = true;
      $('verifyBtn').disabled = true;
      $('verifiedTick').hidden = true;
      return;
    }

    const index = currentIndex();
    $('breadcrumb').textContent = [
      item.course_title,
      item.module_title,
      item.lesson_title
    ].filter(Boolean).join(' → ');

    $('activityTitle').textContent = itemLabel(item);
    $('activityMeta').textContent = `${item.turn_count ?? item.turns.length} lượt · ${item.activity_key || item.dialogue_id}`;
    $('positionText').textContent = `${index + 1} / ${state.visibleItems.length}`;

    list.innerHTML = item.turns.map((turn, turnIndex) => `
      <div class="dialogue-turn">
        <div class="speaker-cell">
          <span class="turn-no">${String(turnIndex + 1).padStart(2, '0')}</span>
          <b class="speaker-name" title="${esc(turn.speaker || '—')}">${esc(turn.speaker || '—')}</b>
        </div>
        <div class="turn-text">${esc(turn.text || '')}</div>
      </div>
    `).join('') || '<div class="empty">Hội thoại này không có lượt thoại.</div>';

    $('prevBtn').disabled = index <= 0;
    $('nextBtn').disabled = index >= state.visibleItems.length - 1;

    const verifyBtn = $('verifyBtn');
    verifyBtn.disabled = false;
    verifyBtn.textContent = item.verified ? 'Đã xác minh' : 'Xác minh';
    verifyBtn.classList.toggle('is-verified', item.verified);
    verifyBtn.setAttribute('aria-pressed', item.verified ? 'true' : 'false');
    $('verifiedTick').hidden = !item.verified;
  }

  function toggleVerified(force) {
    const item = currentItem();
    if (!item) return;

    const nextValue = typeof force === 'boolean' ? force : !item.verified;
    item.verified = nextValue;
    item.verified_at = nextValue ? new Date().toISOString() : null;

    if (state.data) {
      state.data.updated_at = new Date().toISOString();
      state.data.storage = state.fileHandle
        ? 'browser-file-system-access'
        : 'standalone-in-memory-export';
      recalcSummary();
    }

    render();
    setNotice(nextValue ? 'Đã đánh dấu hội thoại đạt chuẩn.' : 'Đã bỏ xác minh.');
  }

  function setNotice(message) {
    $('notice').textContent = message;
    window.clearTimeout(setNotice.timer);
    setNotice.timer = window.setTimeout(() => {
      $('notice').textContent = '';
    }, 2600);
  }

  function exportPayload() {
    if (!state.data) return null;
    const payload = clone(state.data);
    recalcSummary(payload);
    payload.exported_at = new Date().toISOString();
    payload.updated_at = new Date().toISOString();
    payload.storage = 'standalone-json-review';
    payload.navigation_status = $('statusFilter').value;
    return payload;
  }

  function downloadJson() {
    const payload = exportPayload();
    if (!payload) return;

    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: 'application/json;charset=utf-8' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `communication-dialogue-review-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice('Đã xuất JSON mới với trạng thái xác minh hiện tại.');
  }

  async function saveToHandle() {
    if (!state.fileHandle) {
      setNotice('Chưa có file handle. Hãy mở JSON bằng nút Mở JSON.');
      return;
    }

    const payload = exportPayload();
    if (!payload) return;

    try {
      const writable = await state.fileHandle.createWritable();
      await writable.write(JSON.stringify(payload, null, 2));
      await writable.close();
      state.data = normalizeData(payload);
      fillFilters();
      rebuildVisible();
      setNotice('Đã ghi trực tiếp trạng thái vào file JSON đã mở.');
    } catch (error) {
      console.error(error);
      setNotice('Không ghi được file trực tiếp. Hãy dùng Xuất JSON.');
    }
  }

  async function openWithFileSystemAccess() {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: 'JSON',
        accept: { 'application/json': ['.json'] }
      }]
    });

    const file = await handle.getFile();
    const payload = JSON.parse(await file.text());
    state.fileHandle = handle;
    state.data = normalizeData(payload);
    state.currentId = '';
    $('saveJsonBtn').hidden = false;
    fillFilters({ resetLesson: true, resetActivity: true });
    rebuildVisible({ preserveCurrent: false });
    setNotice(`Đã mở ${file.name}. Có thể lưu trực tiếp lại file này.`);
  }

  async function openJson() {
    if ('showOpenFilePicker' in window && window.isSecureContext) {
      try {
        await openWithFileSystemAccess();
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.warn('File System Access API unavailable/failure:', error);
      }
    }
    $('fileInput').click();
  }

  async function loadUploadedFile(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      state.fileHandle = null;
      state.data = normalizeData(payload);
      state.currentId = '';
      $('saveJsonBtn').hidden = true;
      fillFilters({ resetLesson: true, resetActivity: true });
      rebuildVisible({ preserveCurrent: false });
      setNotice(`Đã nạp ${file.name}. Dùng Xuất JSON để lưu thay đổi.`);
    } catch (error) {
      console.error(error);
      setNotice('File JSON không hợp lệ.');
    }
  }

  async function loadBundledData() {
    try {
      const response = await fetch('./data/dialogues.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.data = normalizeData(await response.json());
      fillFilters({ resetLesson: true, resetActivity: true });
      rebuildVisible({ preserveCurrent: false });
      setNotice('Đã tải data/dialogues.json.');
    } catch (error) {
      console.warn(error);
      $('dialogueList').innerHTML =
        '<div class="empty">Không tự đọc được data/dialogues.json. Hãy bấm “Mở JSON”.</div>';
      setNotice('Nếu mở bằng file://, hãy dùng nút Mở JSON hoặc chạy qua web server.');
    }
  }

  $('prevBtn').addEventListener('click', () => move(-1));
  $('nextBtn').addEventListener('click', () => move(1));
  $('verifyBtn').addEventListener('click', () => toggleVerified());
  $('verifiedTick').addEventListener('click', () => toggleVerified(false));
  $('exportJsonBtn').addEventListener('click', downloadJson);
  $('saveJsonBtn').addEventListener('click', saveToHandle);
  $('openJsonBtn').addEventListener('click', openJson);
  $('fileInput').addEventListener('change', event => {
    loadUploadedFile(event.target.files?.[0]);
    event.target.value = '';
  });

  $('moduleFilter').addEventListener('change', () => {
    fillFilters({ resetLesson: true, resetActivity: true });
    rebuildVisible({ preserveCurrent: false });
  });

  $('lessonFilter').addEventListener('change', () => {
    fillFilters({ resetActivity: true });
    rebuildVisible({ preserveCurrent: false });
  });

  $('activityFilter').addEventListener('change', () => {
    rebuildVisible({ preserveCurrent: false });
  });

  $('statusFilter').addEventListener('change', () => {
    rebuildVisible({ preserveCurrent: false });
  });

  window.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') move(-1);
    if (event.key === 'ArrowRight') move(1);
  });

  loadBundledData();
})();
