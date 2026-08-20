(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const LOCAL_REVIEW_STORAGE_KEY = 'engcore.dialogue-review-static.review-state.v1';

  const state = {
    data: null,
    visibleItems: [],
    currentId: '',
    fileHandle: null,
    sourceSnapshot: null,
    localPatches: null,
    fileWriteQueue: Promise.resolve(),
    openNote: null,
    openEdit: null
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
      turns: Array.isArray(item.turns)
        ? item.turns.map(turn => normalizeTurn(turn))
        : []
    }));

    recalcSummary(next);
    return next;
  }

  function noteText(turn) {
    if (!turn) return '';
    if (typeof turn.note === 'string') return turn.note.trim();
    if (turn.note && typeof turn.note === 'object') {
      return String(turn.note.text || '').trim();
    }
    return '';
  }

  function normalizeTurn(turn) {
    const next = turn && typeof turn === 'object' ? { ...turn } : {};
    const text = noteText(next);

    if (text) {
      const noteObject = next.note && typeof next.note === 'object'
        ? { ...next.note }
        : {};
      next.note = {
        ...noteObject,
        text,
        updated_at: noteObject.updated_at || null
      };
    } else {
      delete next.note;
    }

    return next;
  }

  function formatEditNote(oldText, newText) {
    return `[${JSON.stringify(String(oldText ?? ''))}] -> [${JSON.stringify(String(newText ?? ''))}]`;
  }

  function buildAutoEditNote(turn, oldText, newText) {
    const existingNote = turn?.note && typeof turn.note === 'object'
      ? turn.note
      : null;
    const existingAuto = existingNote?.auto_edit && typeof existingNote.auto_edit === 'object'
      ? existingNote.auto_edit
      : null;

    const originalText = typeof existingAuto?.original_text === 'string'
      ? existingAuto.original_text
      : String(oldText ?? '');

    // Nếu trước đó là NOTE thủ công thì giữ lại bên dưới NOTE thay đổi tự động.
    const manualNote = typeof existingAuto?.manual_note === 'string'
      ? existingAuto.manual_note
      : (existingNote && !existingAuto ? noteText(turn) : '');

    const editLine = formatEditNote(originalText, newText);
    return {
      text: manualNote ? `${editLine}\n${manualNote}` : editLine,
      updated_at: new Date().toISOString(),
      auto_edit: {
        original_text: originalText,
        current_text: String(newText ?? ''),
        manual_note: manualNote || ''
      }
    };
  }

  function itemHasNote(item) {
    return Array.isArray(item?.turns)
      && item.turns.some(turn => noteText(turn) !== '');
  }

  function fillBlankWords(item) {
    if (!item || item.activity_title !== 'Reading — Fill Blank') return [];
    if (!Array.isArray(item.fill_blank_words)) return [];
    return item.fill_blank_words
      .map(word => String(word ?? '').trim())
      .filter(Boolean);
  }

  function renderFillBlankReference(item) {
    const reference = $('fillBlankReference');
    const wordsNode = $('fillBlankWords');
    if (!reference || !wordsNode) return;

    const words = fillBlankWords(item);
    if (!words.length) {
      reference.hidden = true;
      wordsNode.innerHTML = '';
      return;
    }

    wordsNode.innerHTML = words
      .map((word, index) => `<span class="fill-blank-word" title="Từ điền ${index + 1}">${esc(word)}</span>`)
      .join('');
    reference.hidden = false;
  }

  function fillBlankMarksForTurn(item, turnIndex) {
    if (!item || item.activity_title !== 'Reading — Fill Blank') return [];
    if (!Array.isArray(item.fill_blank_marks)) return [];

    return item.fill_blank_marks
      .filter(mark => Number(mark?.turn_index) === turnIndex)
      .map(mark => ({
        start: Number(mark?.start),
        end: Number(mark?.end),
        word: String(mark?.word ?? '').trim(),
        blankId: String(mark?.blank_id ?? '').trim()
      }))
      .filter(mark => Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.start >= 0 && mark.end > mark.start)
      .sort((a, b) => a.start - b.start);
  }

  function renderTurnText(item, turn, turnIndex) {
    const text = String(turn?.text ?? '');
    const marks = fillBlankMarksForTurn(item, turnIndex);
    if (!marks.length) return esc(text);

    let cursor = 0;
    const parts = [];

    marks.forEach(mark => {
      if (mark.start < cursor || mark.end > text.length) return;

      const markedText = text.slice(mark.start, mark.end);
      if (mark.word && markedText.toLocaleLowerCase() !== mark.word.toLocaleLowerCase()) return;

      parts.push(esc(text.slice(cursor, mark.start)));
      parts.push(`<span class="turn-fill-blank" title="Từ điền (blank): ${esc(mark.word || markedText)}">${esc(markedText)}</span>`);
      cursor = mark.end;
    });

    parts.push(esc(text.slice(cursor)));
    return parts.join('');
  }

  function readLocalReviewPatches() {
    try {
      const raw = window.localStorage.getItem(LOCAL_REVIEW_STORAGE_KEY);
      if (!raw) return { items: {} };
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object'
        ? parsed
        : { items: {} };
    } catch (error) {
      console.warn('Không đọc được localStorage review state:', error);
      return { items: {} };
    }
  }

  function writeLocalReviewPatches() {
    try {
      const payload = state.localPatches && typeof state.localPatches === 'object'
        ? state.localPatches
        : { items: {} };
      payload.updated_at = new Date().toISOString();
      window.localStorage.setItem(LOCAL_REVIEW_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (error) {
      console.warn('Không ghi được localStorage review state:', error);
      return false;
    }
  }

  function localPatchFor(dialogueId) {
    if (!state.localPatches || typeof state.localPatches !== 'object') {
      state.localPatches = { items: {} };
    }
    if (!state.localPatches.items || typeof state.localPatches.items !== 'object') {
      state.localPatches.items = {};
    }
    if (!state.localPatches.items[dialogueId]) {
      state.localPatches.items[dialogueId] = {};
    }
    return state.localPatches.items[dialogueId];
  }

  function persistVerificationPatch(item) {
    if (!item) return false;
    const patch = localPatchFor(item.dialogue_id);
    patch.verified = Boolean(item.verified);
    patch.verified_at = item.verified ? (item.verified_at || null) : null;
    return writeLocalReviewPatches();
  }

  function persistNotePatch(item, turnIndex) {
    const turn = item?.turns?.[turnIndex];
    if (!item || !turn) return false;
    const patch = localPatchFor(item.dialogue_id);
    if (!patch.notes || typeof patch.notes !== 'object') patch.notes = {};
    const text = noteText(turn);
    patch.notes[String(turnIndex)] = text
      ? normalizeTurn({ note: clone(turn.note) }).note
      : null;
    return writeLocalReviewPatches();
  }

  function persistTurnTextPatch(item, turnIndex) {
    const turn = item?.turns?.[turnIndex];
    if (!item || !turn) return false;
    const patch = localPatchFor(item.dialogue_id);
    if (!patch.texts || typeof patch.texts !== 'object') patch.texts = {};
    patch.texts[String(turnIndex)] = {
      text: String(turn.text ?? ''),
      updated_at: new Date().toISOString()
    };
    return writeLocalReviewPatches();
  }

  function applyLocalReviewPatches(target) {
    if (!target || !Array.isArray(target.items)) return target;
    const patches = state.localPatches?.items;
    if (!patches || typeof patches !== 'object') return target;

    target.items.forEach(item => {
      const patch = patches[item.dialogue_id];
      if (!patch || typeof patch !== 'object') return;

      if (typeof patch.verified === 'boolean') {
        item.verified = patch.verified;
        item.verified_at = patch.verified ? (patch.verified_at || null) : null;
      }

      if (patch.texts && typeof patch.texts === 'object' && Array.isArray(item.turns)) {
        Object.entries(patch.texts).forEach(([indexKey, textPatch]) => {
          const turnIndex = Number(indexKey);
          const turn = item.turns[turnIndex];
          if (!turn) return;
          const nextText = textPatch && typeof textPatch === 'object'
            ? textPatch.text
            : textPatch;
          if (typeof nextText === 'string') {
            turn.text = nextText;
            rebaseFillBlankMarks(item, turnIndex, nextText);
          }
        });
      }

      if (patch.notes && typeof patch.notes === 'object' && Array.isArray(item.turns)) {
        Object.entries(patch.notes).forEach(([indexKey, notePatch]) => {
          const turnIndex = Number(indexKey);
          const turn = item.turns[turnIndex];
          if (!turn) return;
          if (notePatch && String(notePatch.text || '').trim()) {
            turn.note = normalizeTurn({ note: clone(notePatch) }).note;
          } else {
            delete turn.note;
          }
        });
      }
    });

    recalcSummary(target);
    return target;
  }

  function localPatchCount() {
    return Object.keys(state.localPatches?.items || {}).length;
  }

  function ensureStatusOptions() {
    const status = $('statusFilter');
    if (!status || [...status.options].some(option => option.value === 'noted')) {
      return;
    }
    status.add(new Option('Có ghi chú', 'noted'));
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

  function buildSpeakerToneClasses(turns) {
    const speakers = new Map();
    let nextTone = 1;

    return (Array.isArray(turns) ? turns : []).map(turn => {
      const key = String(turn?.speaker || '—').trim().toLocaleLowerCase() || '—';
      if (!speakers.has(key)) {
        speakers.set(key, nextTone);
        nextTone = nextTone >= 6 ? 1 : nextTone + 1;
      }
      return `speaker-tone-${speakers.get(key)}`;
    });
  }

  function uniqueBy(items, keyFn) {
    const seen = new Map();
    items.forEach(item => {
      const key = keyFn(item);
      if (!seen.has(key)) seen.set(key, item);
    });
    return [...seen.values()];
  }

  function option(value, label, className = '') {
    const classAttr = className ? ` class="${esc(className)}"` : '';
    return `<option value="${esc(value)}"${classAttr}>${esc(label)}</option>`;
  }

  function lessonReviewState(items) {
    const total = items.length;
    const verified = items.filter(item => item.verified).length;
    const hasNote = items.some(item => itemHasNote(item));

    return {
      hasNote,
      allVerified: total > 0 && verified === total
    };
  }

  function applySelectedLessonReviewState(lessonNode, lessonStates) {
    const selectedState = lessonStates.get(lessonNode.value);
    lessonNode.classList.toggle('is-review-verified', Boolean(selectedState?.allVerified));
    lessonNode.classList.toggle('is-review-noted', Boolean(selectedState?.hasNote));
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
    const lessonStates = new Map();
    lessonPool.forEach(item => {
      const key = item.lesson_key || item.lesson_title || '';
      if (!lessonStates.has(key)) lessonStates.set(key, []);
      lessonStates.get(key).push(item);
    });
    lessonStates.forEach((items, key) => {
      lessonStates.set(key, lessonReviewState(items));
    });

    const oldLesson = resetLesson ? '' : lessonNode.value;
    lessonNode.innerHTML = option('all', 'Tất cả lesson') + lessons.map(item => {
      const key = item.lesson_key || item.lesson_title;
      const reviewState = lessonStates.get(key) || { hasNote: false, allVerified: false };
      const suffix = `${reviewState.hasNote ? ' ✎' : ''}${reviewState.allVerified ? ' ✓' : ''}`;
      const classNames = [
        reviewState.allVerified ? 'lesson-review-verified' : '',
        reviewState.hasNote ? 'lesson-review-noted' : ''
      ].filter(Boolean).join(' ');
      return option(key, `${item.lesson_key} · ${item.lesson_title}${suffix}`, classNames);
    }).join('');

    if (oldLesson && [...lessonNode.options].some(o => o.value === oldLesson)) {
      lessonNode.value = oldLesson;
    }
    applySelectedLessonReviewState(lessonNode, lessonStates);

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
      if (statusValue === 'noted' && !itemHasNote(item)) return false;
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

  function centerReviewCard() {
    const card = $('reviewCard');
    if (!card) return;

    window.requestAnimationFrame(() => {
      card.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest'
      });
    });
  }

  function relocateNavigationControls() {
    const row = document.querySelector('.verify-row');
    const prev = $('prevBtn');
    const next = $('nextBtn');
    const verify = $('verifyBtn');

    if (!row || !prev || !next || !verify) return;

    row.insertBefore(prev, verify);
    row.appendChild(next);
  }

  function move(delta) {
    const index = currentIndex();
    if (index < 0) return;
    const next = index + delta;
    if (next < 0 || next >= state.visibleItems.length) return;
    state.currentId = state.visibleItems[next].dialogue_id;
    state.openNote = null;
    state.openEdit = null;
    render();
    centerReviewCard();
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
      $('copyDialogueBtn').disabled = true;
      $('verifiedTick').hidden = true;
      renderFillBlankReference(null);
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
    renderFillBlankReference(item);

    const speakerToneClasses = buildSpeakerToneClasses(item.turns);

    list.innerHTML = item.turns.map((turn, turnIndex) => {
      const savedNote = noteText(turn);
      const speakerToneClass = speakerToneClasses[turnIndex] || 'speaker-tone-1';
      return `
        <div class="dialogue-turn ${speakerToneClass} ${savedNote ? 'has-note' : ''}" data-turn-index="${turnIndex}">
          <div class="speaker-cell">
            <span class="turn-no">${String(turnIndex + 1).padStart(2, '0')}</span>
            <b class="speaker-name" title="${esc(turn.speaker || '—')}">${esc(turn.speaker || '—')}</b>
          </div>
          <div class="turn-content">
            <div class="turn-text">${renderTurnText(item, turn, turnIndex)}</div>
            <div class="turn-tools">
              <button
                class="turn-edit-toggle"
                type="button"
                data-edit-toggle="${turnIndex}"
                aria-label="Sửa trực tiếp câu thoại ${turnIndex + 1}"
                title="Sửa trực tiếp câu thoại"
              >Sửa</button>
              <button
                class="turn-note-toggle ${savedNote ? 'is-noted' : ''}"
                type="button"
                data-note-toggle="${turnIndex}"
                aria-label="${savedNote ? 'Sửa ghi chú' : 'Thêm ghi chú'} cho câu ${turnIndex + 1}"
                title="${savedNote ? 'Sửa ghi chú' : 'Thêm ghi chú'}"
              >✎</button>
            </div>
            <div
              class="turn-text-editor"
              data-edit-editor="${turnIndex}"
              ${state.openEdit && state.openEdit.dialogueId === item.dialogue_id && state.openEdit.turnIndex === turnIndex ? '' : 'hidden'}
            >
              <textarea
                class="turn-text-input"
                rows="3"
                maxlength="3000"
                data-edit-input="${turnIndex}"
              >${esc(turn.text || '')}</textarea>
              <div class="turn-edit-actions">
                <button type="button" data-edit-save="${turnIndex}">Lưu thoại</button>
                <button type="button" class="secondary" data-edit-cancel="${turnIndex}">Hủy</button>
              </div>
            </div>
            ${savedNote ? `<div class="turn-note-preview">${esc(savedNote)}</div>` : ''}
            <div
              class="turn-note-editor"
              data-note-editor="${turnIndex}"
              ${state.openNote && state.openNote.dialogueId === item.dialogue_id && state.openNote.turnIndex === turnIndex ? '' : 'hidden'}
            >
              <input
                class="turn-note-input"
                type="text"
                value="${esc(savedNote)}"
                placeholder="Ví dụ: câu này dư / thiếu ý..."
                maxlength="500"
                data-note-input="${turnIndex}"
              >
              <div class="turn-note-actions">
                <button type="button" data-note-save="${turnIndex}">Lưu</button>
                <button type="button" class="secondary" data-note-cancel="${turnIndex}">Hủy</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('') || '<div class="empty">Hội thoại này không có lượt thoại.</div>';

    $('prevBtn').disabled = index <= 0;
    $('nextBtn').disabled = index >= state.visibleItems.length - 1;

    const verifyBtn = $('verifyBtn');
    verifyBtn.disabled = false;
    verifyBtn.textContent = item.verified ? 'Đã xác minh' : 'Xác minh';
    verifyBtn.classList.toggle('is-verified', item.verified);
    verifyBtn.setAttribute('aria-pressed', item.verified ? 'true' : 'false');
    $('copyDialogueBtn').disabled = !Array.isArray(item.turns) || item.turns.length === 0;
    $('verifiedTick').hidden = !item.verified;
  }

  function currentDialogueClipboardText() {
    const item = currentItem();
    if (!item || !Array.isArray(item.turns)) return '';

    // Lấy trực tiếp turn.text hiện tại nên luôn ưu tiên bản mới nhất sau khi user bấm “Sửa”.
    // NOTE không được đưa vào nội dung clipboard.
    return item.turns
      .map(turn => {
        const speaker = String(turn?.speaker ?? '—').trim() || '—';
        const text = String(turn?.text ?? '').trim();
        return `${speaker} - ${text}`;
      })
      .join('\n');
  }

  async function copyCurrentDialogue() {
    const text = currentDialogueClipboardText();
    if (!text) {
      setNotice('Hội thoại hiện tại không có nội dung để copy.');
      return;
    }

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('Clipboard API unavailable');
      }
      setNotice('Đã copy hội thoại theo dạng Speaker - Thoại, mỗi lượt một dòng.');
      return;
    } catch (error) {
      // Fallback để vẫn hoạt động khi mở tool bằng file:// hoặc trình duyệt chặn Clipboard API.
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.select();

      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (fallbackError) {
        copied = false;
      } finally {
        textarea.remove();
      }

      setNotice(copied
        ? 'Đã copy hội thoại theo dạng Speaker - Thoại, mỗi lượt một dòng.'
        : 'Không copy được vào clipboard. Hãy kiểm tra quyền clipboard của trình duyệt.');
    }
  }

  async function persistCurrentFileSilently() {
    if (!state.fileHandle || !state.data) return false;

    state.fileWriteQueue = state.fileWriteQueue.then(async () => {
      const payload = exportPayload();
      const writable = await state.fileHandle.createWritable();
      await writable.write(JSON.stringify(payload, null, 2));
      await writable.close();
      return true;
    }).catch(error => {
      console.error(error);
      return false;
    });

    return state.fileWriteQueue;
  }

  function rebaseFillBlankMarks(item, turnIndex, newText) {
    if (!item || item.activity_title !== 'Reading — Fill Blank' || !Array.isArray(item.fill_blank_marks)) {
      return { ok: true, updated: 0 };
    }

    const marks = item.fill_blank_marks
      .filter(mark => Number(mark?.turn_index) === turnIndex)
      .sort((a, b) => Number(a.start) - Number(b.start));
    if (!marks.length) return { ok: true, updated: 0 };

    const lowerText = newText.toLocaleLowerCase();
    let cursor = 0;
    const nextRanges = [];

    for (const mark of marks) {
      const word = String(mark?.word ?? '').trim();
      if (!word) continue;
      const start = lowerText.indexOf(word.toLocaleLowerCase(), cursor);
      if (start < 0) {
        return { ok: false, missing: word };
      }
      nextRanges.push({ mark, start, end: start + word.length });
      cursor = start + word.length;
    }

    nextRanges.forEach(range => {
      range.mark.start = range.start;
      range.mark.end = range.end;
    });
    return { ok: true, updated: nextRanges.length };
  }

  async function saveTurnText(turnIndex, value) {
    const item = currentItem();
    const turn = item?.turns?.[turnIndex];
    if (!turn || !state.data) return;

    const text = String(value ?? '').trim();
    if (!text) {
      setNotice('Câu thoại không được để trống.');
      return;
    }

    const rebased = rebaseFillBlankMarks(item, turnIndex, text);
    if (!rebased.ok) {
      setNotice(`Không thể lưu: câu này phải giữ từ điền “${rebased.missing}”.`);
      return;
    }

    const oldText = String(turn.text ?? '');
    if (text === oldText) {
      state.openEdit = null;
      render();
      return;
    }

    // Câu mới được hiển thị ngay trong hội thoại; NOTE giữ dấu vết câu cũ -> câu mới
    // để activity tự lọt vào nhóm “Có ghi chú” khi xuất JSON phục vụ upsert.
    turn.note = buildAutoEditNote(turn, oldText, text);
    turn.text = text;
    state.data.updated_at = new Date().toISOString();
    state.data.storage = state.fileHandle
      ? 'browser-file-system-access'
      : 'browser-localStorage';
    state.openEdit = null;
    // NOTE tự động phải phản ánh ngay ở badge/filter “Có ghi chú”.
    fillFilters();
    rebuildVisible({ preserveCurrent: true });

    if (state.fileHandle) {
      const written = await persistCurrentFileSilently();
      setNotice(written
        ? 'Đã sửa câu thoại, tự tạo NOTE câu cũ -> câu mới và ghi trực tiếp vào file JSON.'
        : 'Đã sửa câu thoại và tạo NOTE trong dữ liệu hiện tại, nhưng chưa ghi được file.');
    } else {
      const textPersisted = persistTurnTextPatch(item, turnIndex);
      const notePersisted = persistNotePatch(item, turnIndex);
      setNotice(textPersisted && notePersisted
        ? 'Đã sửa câu thoại và tự tạo NOTE câu cũ -> câu mới. Reload vẫn giữ nguyên.'
        : 'Đã sửa câu thoại và tạo NOTE, nhưng trình duyệt không lưu được đầy đủ localStorage.');
    }
  }

  function toggleEditEditor(turnIndex, forceOpen = null) {
    const item = currentItem();
    if (!item || !item.turns?.[turnIndex]) return;

    const isOpen = Boolean(
      state.openEdit
      && state.openEdit.dialogueId === item.dialogue_id
      && state.openEdit.turnIndex === turnIndex
    );
    const shouldOpen = forceOpen === null ? !isOpen : Boolean(forceOpen);

    state.openNote = null;
    state.openEdit = shouldOpen
      ? { dialogueId: item.dialogue_id, turnIndex }
      : null;

    render();

    if (shouldOpen) {
      window.requestAnimationFrame(() => {
        const input = document.querySelector(`[data-edit-input="${turnIndex}"]`);
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  }

  async function saveTurnNote(turnIndex, value) {
    const item = currentItem();
    const turn = item?.turns?.[turnIndex];
    if (!turn || !state.data) return;

    const text = String(value || '').trim();

    if (text) {
      turn.note = {
        text,
        updated_at: new Date().toISOString()
      };
    } else {
      delete turn.note;
    }

    state.data.updated_at = new Date().toISOString();
    state.data.storage = state.fileHandle
      ? 'browser-file-system-access'
      : 'browser-localStorage';

    state.openNote = null;
    fillFilters();
    rebuildVisible({ preserveCurrent: true });

    if (state.fileHandle) {
      const written = await persistCurrentFileSilently();
      setNotice(written
        ? (text ? 'Đã lưu ghi chú trực tiếp vào file JSON.' : 'Đã xóa ghi chú khỏi file JSON.')
        : 'Đã cập nhật ghi chú trong dữ liệu hiện tại, nhưng chưa ghi được file.');
    } else {
      const persisted = persistNotePatch(item, turnIndex);
      setNotice(persisted
        ? (text ? 'Đã lưu ghi chú. Reload vẫn giữ nguyên.' : 'Đã xóa ghi chú. Reload vẫn giữ nguyên.')
        : 'Đã cập nhật ghi chú, nhưng trình duyệt không lưu được localStorage.');
    }
  }

  function toggleNoteEditor(turnIndex, forceOpen = null) {
    const item = currentItem();
    if (!item || !item.turns?.[turnIndex]) return;

    const isOpen = Boolean(
      state.openNote
      && state.openNote.dialogueId === item.dialogue_id
      && state.openNote.turnIndex === turnIndex
    );
    const shouldOpen = forceOpen === null ? !isOpen : Boolean(forceOpen);

    state.openEdit = null;
    state.openNote = shouldOpen
      ? { dialogueId: item.dialogue_id, turnIndex }
      : null;

    render();

    if (shouldOpen) {
      window.requestAnimationFrame(() => {
        const input = document.querySelector(`[data-note-input="${turnIndex}"]`);
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  }

  async function toggleVerified(force) {
    const item = currentItem();
    if (!item) return;

    const nextValue = typeof force === 'boolean' ? force : !item.verified;
    item.verified = nextValue;
    item.verified_at = nextValue ? new Date().toISOString() : null;

    if (state.data) {
      state.data.updated_at = new Date().toISOString();
      state.data.storage = state.fileHandle
        ? 'browser-file-system-access'
        : 'browser-localStorage';
      recalcSummary();
      fillFilters();
    }

    render();

    if (state.fileHandle) {
      const written = await persistCurrentFileSilently();
      setNotice(written
        ? (nextValue
            ? 'Đã xác minh và ghi trực tiếp vào file JSON.'
            : 'Đã bỏ xác minh và ghi trực tiếp vào file JSON.')
        : 'Đã đổi trạng thái, nhưng chưa ghi được file JSON.');
      return;
    }

    const persisted = persistVerificationPatch(item);
    setNotice(persisted
      ? (nextValue
          ? 'Đã xác minh. Reload vẫn giữ nguyên.'
          : 'Đã bỏ xác minh. Reload vẫn giữ nguyên.')
      : 'Đã đổi trạng thái, nhưng trình duyệt không lưu được localStorage.');
  }

  function clearReviewLocalStorage() {
    const patchCount = localPatchCount();
    const confirmed = window.confirm(
      patchCount
        ? `Xóa localStorage của Dialogue Review? ${patchCount} hội thoại đang có dữ liệu lưu cục bộ sẽ được reset về JSON nguồn.`
        : 'Xóa localStorage của Dialogue Review?'
    );
    if (!confirmed) return;

    try {
      window.localStorage.removeItem(LOCAL_REVIEW_STORAGE_KEY);
    } catch (error) {
      console.warn('Không xóa được localStorage review state:', error);
      setNotice('Không xóa được localStorage trên trình duyệt này.');
      return;
    }

    state.localPatches = { items: {} };
    state.openNote = null;
    state.openEdit = null;

    if (!state.fileHandle && state.sourceSnapshot) {
      state.data = normalizeData(clone(state.sourceSnapshot));
      state.currentId = '';
      fillFilters({ resetLesson: true, resetActivity: true });
      rebuildVisible({ preserveCurrent: false });
      setNotice('Đã xóa localStorage và reset dữ liệu về JSON nguồn.');
      return;
    }

    setNotice('Đã xóa localStorage của Dialogue Review. File JSON đang mở không bị thay đổi.');
  }

  function setNotice(message) {
    $('notice').textContent = message;
    window.clearTimeout(setNotice.timer);
    setNotice.timer = window.setTimeout(() => {
      $('notice').textContent = '';
    }, 2600);
  }

  function activityIdentity(item, index = 0) {
    if (item?.activity_id !== undefined && item?.activity_id !== null && String(item.activity_id) !== '') {
      return `id:${item.activity_id}`;
    }
    if (item?.activity_key) return `key:${item.activity_key}`;
    return `dialogue:${item?.dialogue_id || index}`;
  }

  function exportPayload(scope = 'full') {
    if (!state.data) return null;
    const payload = clone(state.data);

    if (scope === 'noted') {
      const notedActivityIds = new Set();
      payload.items.forEach((item, index) => {
        if (itemHasNote(item)) notedActivityIds.add(activityIdentity(item, index));
      });

      payload.items = payload.items.filter((item, index) =>
        notedActivityIds.has(activityIdentity(item, index))
      );
      payload.export_scope = 'activities_with_notes';
      payload.noted_activity_count = notedActivityIds.size;
    } else {
      payload.export_scope = 'full';
      delete payload.noted_activity_count;
    }

    recalcSummary(payload);
    payload.exported_at = new Date().toISOString();
    payload.updated_at = new Date().toISOString();
    payload.storage = 'standalone-json-review';
    payload.navigation_status = $('statusFilter').value;
    return payload;
  }

  function askExportScope() {
    return new Promise(resolve => {
      const existing = document.querySelector('.export-choice-backdrop');
      if (existing) existing.remove();

      const backdrop = document.createElement('div');
      backdrop.className = 'export-choice-backdrop';
      backdrop.innerHTML = `
        <div class="export-choice-dialog" role="dialog" aria-modal="true" aria-labelledby="exportChoiceTitle">
          <div id="exportChoiceTitle" class="export-choice-title">Xuất JSON</div>
          <div class="export-choice-text">Bạn muốn xuất phạm vi nào?</div>
          <div class="export-choice-actions">
            <button type="button" data-export-scope="full">Xuất full JSON</button>
            <button type="button" data-export-scope="noted" class="secondary">Chỉ activity có ghi chú</button>
            <button type="button" data-export-scope="cancel" class="secondary export-choice-cancel">Hủy</button>
          </div>
        </div>`;

      const finish = value => {
        document.removeEventListener('keydown', onKeydown, true);
        backdrop.remove();
        resolve(value);
      };
      const onKeydown = event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      };

      backdrop.addEventListener('click', event => {
        const button = event.target.closest('[data-export-scope]');
        if (button) {
          const value = button.dataset.exportScope;
          finish(value === 'cancel' ? null : value);
          return;
        }
        if (event.target === backdrop) finish(null);
      });

      document.addEventListener('keydown', onKeydown, true);
      document.body.appendChild(backdrop);
      backdrop.querySelector('[data-export-scope="full"]')?.focus();
    });
  }

  async function downloadJson() {
    const scope = await askExportScope();
    if (!scope) return;

    const payload = exportPayload(scope);
    if (!payload) return;

    if (scope === 'noted' && !payload.items.length) {
      setNotice('Không có activity nào đang có ghi chú.');
      return;
    }

    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: 'application/json;charset=utf-8' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = scope === 'noted'
      ? `communication-dialogue-review-noted-activities-${stamp}.json`
      : `communication-dialogue-review-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice(scope === 'noted'
      ? `Đã xuất ${payload.noted_activity_count} activity có ghi chú.`
      : 'Đã xuất full JSON với trạng thái xác minh hiện tại.');
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
    state.sourceSnapshot = clone(payload);
    state.data = normalizeData(payload);
    state.currentId = '';
    $('saveJsonBtn').hidden = false;
    fillFilters({ resetLesson: true, resetActivity: true });
    rebuildVisible({ preserveCurrent: false });
    setNotice(`Đã mở ${file.name}. Xác minh và ghi chú sẽ tự ghi trực tiếp vào file này.`);
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
      state.sourceSnapshot = clone(payload);
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
      state.fileHandle = null;
      state.localPatches = readLocalReviewPatches();
      const payload = await response.json();
      state.sourceSnapshot = clone(payload);
      state.data = applyLocalReviewPatches(normalizeData(payload));
      fillFilters({ resetLesson: true, resetActivity: true });
      rebuildVisible({ preserveCurrent: false });
      setNotice(localPatchCount()
        ? 'Đã tải data/dialogues.json và khôi phục trạng thái đã lưu trên trình duyệt.'
        : 'Đã tải data/dialogues.json.');
    } catch (error) {
      console.warn(error);
      $('dialogueList').innerHTML =
        '<div class="empty">Không tự đọc được data/dialogues.json. Hãy bấm “Mở JSON”.</div>';
      setNotice('Nếu mở bằng file://, hãy dùng nút Mở JSON hoặc chạy qua web server.');
    }
  }

  $('dialogueList').addEventListener('click', event => {
    const editToggle = event.target.closest('[data-edit-toggle]');
    if (editToggle) {
      toggleEditEditor(Number(editToggle.dataset.editToggle));
      return;
    }

    const editSave = event.target.closest('[data-edit-save]');
    if (editSave) {
      const index = Number(editSave.dataset.editSave);
      const input = document.querySelector(`[data-edit-input="${index}"]`);
      saveTurnText(index, input?.value || '');
      return;
    }

    const editCancel = event.target.closest('[data-edit-cancel]');
    if (editCancel) {
      toggleEditEditor(Number(editCancel.dataset.editCancel), false);
      return;
    }

    const toggle = event.target.closest('[data-note-toggle]');
    if (toggle) {
      toggleNoteEditor(Number(toggle.dataset.noteToggle));
      return;
    }

    const save = event.target.closest('[data-note-save]');
    if (save) {
      const index = Number(save.dataset.noteSave);
      const input = document.querySelector(`[data-note-input="${index}"]`);
      saveTurnNote(index, input?.value || '');
      return;
    }

    const cancel = event.target.closest('[data-note-cancel]');
    if (cancel) {
      toggleNoteEditor(Number(cancel.dataset.noteCancel), false);
    }
  });

  $('dialogueList').addEventListener('keydown', event => {
    if (event.target.matches('[data-edit-input]')) {
      const index = Number(event.target.dataset.editInput);
      if (event.key === 'Escape') {
        event.preventDefault();
        toggleEditEditor(index, false);
        return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveTurnText(index, event.target.value);
        return;
      }
    }

    if (event.key !== 'Enter' || !event.target.matches('[data-note-input]')) return;
    event.preventDefault();
    const index = Number(event.target.dataset.noteInput);
    saveTurnNote(index, event.target.value);
  });

  relocateNavigationControls();

  $('prevBtn').addEventListener('click', () => move(-1));
  $('nextBtn').addEventListener('click', () => move(1));
  $('verifyBtn').addEventListener('click', () => toggleVerified());
  $('verifiedTick').addEventListener('click', () => toggleVerified(false));
  $('copyDialogueBtn').addEventListener('click', copyCurrentDialogue);
  $('exportJsonBtn').addEventListener('click', downloadJson);
  $('saveJsonBtn').addEventListener('click', saveToHandle);
  $('openJsonBtn').addEventListener('click', openJson);
  $('clearLocalStorageBtn').addEventListener('click', clearReviewLocalStorage);
  $('fileInput').addEventListener('change', event => {
    loadUploadedFile(event.target.files?.[0]);
    event.target.value = '';
  });

  $('moduleFilter').addEventListener('change', () => {
    state.openNote = null;
    state.openEdit = null;
    fillFilters({ resetLesson: true, resetActivity: true });
    rebuildVisible({ preserveCurrent: false });
  });

  $('lessonFilter').addEventListener('change', () => {
    state.openNote = null;
    state.openEdit = null;
    fillFilters({ resetActivity: true });
    rebuildVisible({ preserveCurrent: false });
  });

  $('activityFilter').addEventListener('change', () => {
    state.openNote = null;
    state.openEdit = null;
    rebuildVisible({ preserveCurrent: false });
  });

  $('statusFilter').addEventListener('change', () => {
    state.openNote = null;
    state.openEdit = null;
    rebuildVisible({ preserveCurrent: false });
  });

  window.addEventListener('keydown', event => {
    const target = event.target;
    if (
      target instanceof HTMLElement
      && (
        target.matches('input, textarea, select, [contenteditable="true"]')
        || target.closest('.turn-note-editor')
      )
    ) {
      return;
    }

    if (event.key === 'ArrowLeft') move(-1);
    if (event.key === 'ArrowRight') move(1);
  });

  state.localPatches = readLocalReviewPatches();
  ensureStatusOptions();
  loadBundledData();
})();
