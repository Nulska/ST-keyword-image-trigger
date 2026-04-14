import {
    chat,
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../extensions.js';
import { dragElement } from '../../RossAscends-mods.js';

const EXTENSION_NAME = 'keyword-image-trigger';
const SETTINGS_KEY = 'keywordImageTrigger';
const SERVER_PLUGIN_ID = 'keyword-image-trigger';
const API_BASE = `/api/plugins/${SERVER_PLUGIN_ID}`;
const INLINE_CONTAINER_CLASS = 'kit-inline-images';
const PREVIEW_ID = 'kit_zoom_preview';
const PREVIEW_ANIMATION_MS = 125;

const defaultSettings = {
    enabled: true,
    detectionDepth: 3,
    imageMaxWidth: 240,
    cardBackgroundColor: '#1f2937',
};

let entries = [];
let serverAvailable = false;
let serverWarningShown = false;
let entrySearchTerm = '';

function ensureSettings() {
    extension_settings[SETTINGS_KEY] = extension_settings[SETTINGS_KEY] || {};
    const settings = extension_settings[SETTINGS_KEY];

    if (typeof settings.enabled !== 'boolean') {
        settings.enabled = defaultSettings.enabled;
    }

    const depth = Number.parseInt(settings.detectionDepth, 10);
    settings.detectionDepth = Number.isFinite(depth) ? Math.min(50, Math.max(1, depth)) : defaultSettings.detectionDepth;

    const maxWidth = Number.parseInt(settings.imageMaxWidth, 10);
    settings.imageMaxWidth = Number.isFinite(maxWidth) ? Math.min(1200, Math.max(80, maxWidth)) : defaultSettings.imageMaxWidth;

    if (typeof settings.cardBackgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(settings.cardBackgroundColor)) {
        settings.cardBackgroundColor = defaultSettings.cardBackgroundColor;
    }

    return settings;
}

const settings = ensureSettings();

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function normalizedText(value) {
    return String(value ?? '').toLocaleLowerCase();
}

function setServerStatus(message, isError = false) {
    const status = document.getElementById('kit_server_status');
    if (!status) {
        return;
    }

    status.textContent = message || '';
    status.style.color = isError ? 'var(--crimson)' : '';
}

function getHeadersForFormData() {
    const headers = { ...getRequestHeaders() };
    delete headers['Content-Type'];
    return headers;
}

async function fetchEntries() {
    try {
        const response = await fetch(`${API_BASE}/entries`, {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        entries = await response.json();
        serverAvailable = true;
        setServerStatus('Server plugin 已连接。');
    } catch (error) {
        entries = [];
        serverAvailable = false;
        setServerStatus('未连接到 server plugin。请在 config.yaml 中启用 enableServerPlugins，然后重启 SillyTavern。', true);

        if (!serverWarningShown) {
            serverWarningShown = true;
            toastr.warning('Keyword Image Trigger 需要启用 server plugin 才能上传和读取图片。');
        }
    }

    renderEntries();
    scanVisibleMessages();
}

function renderEntries() {
    const container = document.getElementById('kit_entries');
    if (!container) {
        return;
    }

    if (entries.length === 0) {
        container.innerHTML = '<div class="kit-empty">还没有图片条目。</div>';
        return;
    }

    const searchTerm = normalizedText(entrySearchTerm.trim());
    const filteredEntries = searchTerm
        ? entries.filter((entry) => normalizedText(entry.keyword).includes(searchTerm))
        : entries;

    if (filteredEntries.length === 0) {
        container.innerHTML = '<div class="kit-empty">没有匹配的条目。</div>';
        return;
    }

    container.innerHTML = filteredEntries.map((entry) => `
        <div class="kit-entry" data-kit-entry-id="${escapeHtml(entry.id)}">
            <img src="${escapeHtml(entry.imageUrl)}" alt="${escapeHtml(entry.keyword)}" loading="lazy" />
            <div class="kit-entry-main">
                <div class="kit-entry-keyword">${escapeHtml(entry.keyword)}</div>
                <div class="kit-entry-file">${escapeHtml(entry.fileName)}</div>
            </div>
            <div class="kit-entry-actions">
                <button class="menu_button menu_button_icon kit-replace-entry" type="button" data-kit-replace="${escapeHtml(entry.id)}" title="替换图片" aria-label="替换图片">
                    <i class="fa-solid fa-rotate-right"></i>
                </button>
                <button class="menu_button menu_button_icon kit-delete-entry" type="button" data-kit-delete="${escapeHtml(entry.id)}" title="删除条目" aria-label="删除条目">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.kit-replace-entry').forEach((button) => {
        button.addEventListener('click', () => {
            const id = button.getAttribute('data-kit-replace');
            if (!id) {
                return;
            }
            promptReplaceEntry(id);
        });
    });

    container.querySelectorAll('.kit-delete-entry').forEach((button) => {
        button.addEventListener('click', async () => {
            const id = button.getAttribute('data-kit-delete');
            if (!id) {
                return;
            }
            await deleteEntry(id);
        });
    });
}

function findTriggeredEntries(messageId) {
    if (!settings.enabled || !entries.length) {
        return [];
    }

    const targetId = Number(messageId);
    if (!Number.isFinite(targetId) || targetId < 0) {
        return [];
    }

    const start = Math.max(0, targetId - settings.detectionDepth + 1);
    const combinedText = normalizedText(
        chat
            .slice(start, targetId + 1)
            .map((message) => {
                if (!message) {
                    return '';
                }

                const displayText = message.extra?.display_text ?? '';
                return `${message.name ?? ''}\n${displayText}\n${message.mes ?? ''}`;
            })
            .join('\n'),
    );

    return entries.filter((entry) => combinedText.includes(normalizedText(entry.keyword)));
}

function closeImagePreview(immediate = false) {
    const preview = document.getElementById(PREVIEW_ID);
    if (!(preview instanceof HTMLElement)) {
        return;
    }

    if (immediate) {
        preview.remove();
        return;
    }

    $(preview).fadeOut(PREVIEW_ANIMATION_MS, () => preview.remove());
}

function openImagePreview(entry) {
    closeImagePreview(true);

    const template = $('#zoomed_avatar_template').html();
    if (!template) {
        window.open(entry.imageUrl, '_blank', 'noopener');
        return;
    }

    const preview = $(template);
    preview.attr('id', PREVIEW_ID);
    preview.attr('data-kit-preview', 'true');
    preview.addClass('draggable');
    preview.find('.drag-grabber').attr('id', `${PREVIEW_ID}header`);

    const image = preview.find('.zoomed_avatar_img');
    image.attr('src', entry.imageUrl);
    image.attr('alt', entry.keyword);
    image.attr('data-izoomify-url', entry.imageUrl);

    $('body').append(preview);
    preview.hide().css('display', 'flex').fadeIn(PREVIEW_ANIMATION_MS);
    dragElement(preview);

    const zoomContainer = preview.find('.zoomed_avatar_container');
    if (typeof zoomContainer.izoomify === 'function') {
        zoomContainer.izoomify();
    }

    preview.on('click touchend', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        if (target.closest('.dragClose') || target === preview.get(0)) {
            closeImagePreview();
        }
    });

    image.on('dragstart', (event) => {
        event.preventDefault();
        return false;
    });
}

function renderInlineImages(messageId) {
    const mesText = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!(mesText instanceof HTMLElement)) {
        return;
    }

    mesText.querySelector(`:scope > .${INLINE_CONTAINER_CLASS}`)?.remove();

    if (!settings.enabled || !serverAvailable) {
        return;
    }

    const matchedEntries = findTriggeredEntries(messageId);
    if (!matchedEntries.length) {
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = INLINE_CONTAINER_CLASS;

    for (const entry of matchedEntries) {
        const card = document.createElement('div');
        card.className = 'kit-inline-card';
        card.style.backgroundColor = settings.cardBackgroundColor;
        card.style.setProperty('--kit-inline-width', `${settings.imageMaxWidth}px`);

        const button = document.createElement('button');
        button.className = 'kit-inline-image-button';
        button.type = 'button';
        button.title = `查看 ${entry.keyword}`;

        const image = document.createElement('img');
        image.className = 'kit-inline-image';
        image.src = entry.imageUrl;
        image.alt = entry.keyword;
        image.loading = 'lazy';
        image.style.maxWidth = `${settings.imageMaxWidth}px`;
        image.style.width = 'auto';
        image.style.height = 'auto';

        const title = document.createElement('div');
        title.className = 'kit-inline-trigger';
        title.textContent = entry.keyword;

        button.addEventListener('click', () => openImagePreview(entry));
        button.appendChild(image);
        card.append(button, title);
        wrapper.appendChild(card);
    }

    mesText.appendChild(wrapper);
}
function scanVisibleMessages() {
    document.querySelectorAll('#chat .mes[mesid]').forEach((element) => {
        const messageId = element.getAttribute('mesid');
        if (messageId !== null) {
            renderInlineImages(messageId);
        }
    });
}

async function submitEntryImage(keyword, file, successMessage, failurePrefix) {
    const formData = new FormData();
    formData.append('keyword', keyword);
    formData.append('avatar', file);

    try {
        const response = await fetch(`${API_BASE}/entries`, {
            method: 'POST',
            headers: getHeadersForFormData(),
            body: formData,
        });

        if (!response.ok) {
            const message = await response.text();
            throw new Error(message || `HTTP ${response.status}`);
        }

        toastr.success(successMessage);
        await fetchEntries();
        return true;
    } catch (error) {
        toastr.error(`${failurePrefix}：${error.message}`);
        return false;
    }
}

async function uploadEntry() {
    const keywordInput = document.getElementById('kit_keyword');
    const fileInput = document.getElementById('kit_file');
    const fileName = document.getElementById('kit_file_name');

    if (!(keywordInput instanceof HTMLInputElement) || !(fileInput instanceof HTMLInputElement) || !(fileName instanceof HTMLElement)) {
        return;
    }

    const keyword = keywordInput.value.trim();
    const file = fileInput.files?.[0];

    if (!keyword) {
        toastr.warning('请先输入触发词。');
        return;
    }

    if (!file) {
        toastr.warning('请先选择一张图片。');
        return;
    }

    const uploaded = await submitEntryImage(keyword, file, '图片已上传。', '上传失败');
    if (!uploaded) {
        return;
    }

    keywordInput.value = '';
    fileInput.value = '';
    fileName.textContent = '未选择文件';
}

async function replaceEntryImage(id, file) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) {
        toastr.warning('未找到要替换的条目。');
        return;
    }

    if (!file) {
        toastr.warning('请先选择一张图片。');
        return;
    }

    await submitEntryImage(entry.keyword, file, `已替换 ${entry.keyword} 的图片。`, '替换失败');
}

function promptReplaceEntry(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) {
        toastr.warning('未找到要替换的条目。');
        return;
    }

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.style.display = 'none';

    picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        picker.remove();

        if (!file) {
            return;
        }

        await replaceEntryImage(id, file);
    }, { once: true });

    document.body.appendChild(picker);
    picker.click();
}

async function deleteEntry(id) {
    try {
        const response = await fetch(`${API_BASE}/entries/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const message = await response.text();
            throw new Error(message || `HTTP ${response.status}`);
        }

        toastr.success('条目已删除。');
        await fetchEntries();
    } catch (error) {
        toastr.error(`删除失败：${error.message}`);
    }
}

function bindSettings() {
    const enabledInput = document.getElementById('kit_enabled');
    const depthInput = document.getElementById('kit_depth');
    const maxWidthInput = document.getElementById('kit_max_width');
    const bgColorInput = document.getElementById('kit_bg_color');
    const fileInput = document.getElementById('kit_file');
    const fileName = document.getElementById('kit_file_name');
    const entrySearchInput = document.getElementById('kit_entry_search');
    const uploadButton = document.getElementById('kit_upload');
    const refreshButton = document.getElementById('kit_refresh');

    if (!(enabledInput instanceof HTMLInputElement)
        || !(depthInput instanceof HTMLInputElement)
        || !(maxWidthInput instanceof HTMLInputElement)
        || !(bgColorInput instanceof HTMLInputElement)
        || !(fileInput instanceof HTMLInputElement)
        || !(fileName instanceof HTMLElement)
        || !(entrySearchInput instanceof HTMLInputElement)
        || !(uploadButton instanceof HTMLButtonElement)
        || !(refreshButton instanceof HTMLButtonElement)) {
        return;
    }

    enabledInput.checked = settings.enabled;
    depthInput.value = String(settings.detectionDepth);
    maxWidthInput.value = String(settings.imageMaxWidth);
    bgColorInput.value = settings.cardBackgroundColor;
    fileName.textContent = fileInput.files?.[0]?.name || '未选择文件';
    entrySearchInput.value = entrySearchTerm;

    enabledInput.addEventListener('change', () => {
        settings.enabled = enabledInput.checked;
        saveSettingsDebounced();
        scanVisibleMessages();
    });

    depthInput.addEventListener('change', () => {
        const depth = Number.parseInt(depthInput.value, 10);
        settings.detectionDepth = Number.isFinite(depth) ? Math.min(50, Math.max(1, depth)) : defaultSettings.detectionDepth;
        depthInput.value = String(settings.detectionDepth);
        saveSettingsDebounced();
        scanVisibleMessages();
    });

    maxWidthInput.addEventListener('change', () => {
        const maxWidth = Number.parseInt(maxWidthInput.value, 10);
        settings.imageMaxWidth = Number.isFinite(maxWidth) ? Math.min(1200, Math.max(80, maxWidth)) : defaultSettings.imageMaxWidth;
        maxWidthInput.value = String(settings.imageMaxWidth);
        saveSettingsDebounced();
        scanVisibleMessages();
    });

    bgColorInput.addEventListener('input', () => {
        settings.cardBackgroundColor = bgColorInput.value;
        saveSettingsDebounced();
        scanVisibleMessages();
    });

    fileInput.addEventListener('change', () => {
        fileName.textContent = fileInput.files?.[0]?.name || '未选择文件';
    });

    entrySearchInput.addEventListener('input', () => {
        entrySearchTerm = entrySearchInput.value;
        renderEntries();
    });

    uploadButton.addEventListener('click', uploadEntry);
    refreshButton.addEventListener('click', fetchEntries);
}

async function initUi() {
    if (document.getElementById('kit_container')) {
        bindSettings();
        await fetchEntries();
        return;
    }

    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    $('#extensions_settings').append(settingsHtml);
    bindSettings();
    await fetchEntries();
}

function scheduleVisibleScan() {
    window.setTimeout(scanVisibleMessages, 0);
}

eventSource.on(event_types.APP_READY, initUi);
eventSource.on(event_types.CHAT_CHANGED, scheduleVisibleScan);
eventSource.on(event_types.MESSAGE_UPDATED, (messageId) => renderInlineImages(messageId));
eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => renderInlineImages(messageId));
eventSource.on(event_types.MESSAGE_DELETED, scheduleVisibleScan);
eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => renderInlineImages(messageId));
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => renderInlineImages(messageId));









