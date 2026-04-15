import {
    chat,
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { getContext } from '../../../st-context.js';

const EXTENSION_NAME = 'third-party/ST-keyword-image-trigger';
const SETTINGS_KEY = 'keywordImageTrigger';
const SERVER_PLUGIN_ID = 'keyword-image-trigger';
const API_BASE = `/api/plugins/${SERVER_PLUGIN_ID}`;
const INLINE_CONTAINER_CLASS = 'kit-inline-images';
const PREVIEW_ID = 'kit_zoom_preview';
const IMAGE_PICKER_ID = 'kit_image_picker';
const PREVIEW_ANIMATION_MS = 125;

const defaultSettings = {
    enabled: true,
    detectionDepth: 3,
    displayDepth: 50,
    imageMaxWidth: 240,
    cardBackgroundColor: '#1f2937',
    selectedImages: {},
};

let globalEntries = [];
let characterEntries = [];
let serverAvailable = false;
let serverWarningShown = false;
let entrySearchTerm = '';
let imagePickerPopup = null;

const clampInteger = (value, minimum, maximum, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

function ensureSettings() {
    extension_settings[SETTINGS_KEY] = extension_settings[SETTINGS_KEY] || {};
    const settings = extension_settings[SETTINGS_KEY];
    if (typeof settings.enabled !== 'boolean') settings.enabled = defaultSettings.enabled;
    settings.detectionDepth = clampInteger(settings.detectionDepth, 1, 50, defaultSettings.detectionDepth);
    settings.displayDepth = clampInteger(settings.displayDepth, 0, 50, defaultSettings.displayDepth);
    settings.imageMaxWidth = clampInteger(settings.imageMaxWidth, 80, 1200, defaultSettings.imageMaxWidth);
    if (typeof settings.cardBackgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(settings.cardBackgroundColor)) {
        settings.cardBackgroundColor = defaultSettings.cardBackgroundColor;
    }
    if (typeof settings.selectedImages !== 'object' || settings.selectedImages === null || Array.isArray(settings.selectedImages)) {
        settings.selectedImages = {};
    }
    return settings;
}

const settings = ensureSettings();
const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;');
const normalizedText = (value) => String(value ?? '').toLocaleLowerCase();
const getEntryImages = (entry) => Array.isArray(entry?.images) && entry.images.length ? entry.images : (entry?.imageUrl ? [{ slot: 0, fileName: entry.fileName ?? '', imageUrl: entry.imageUrl }] : []);
const getEntryKeywords = (entry) => Array.isArray(entry?.keywords) && entry.keywords.length ? entry.keywords.map((keyword) => String(keyword).trim()).filter(Boolean) : (String(entry?.keyword ?? '').trim() ? [String(entry.keyword).trim()] : []);
const getPrimaryKeyword = (entry) => getEntryKeywords(entry)[0] ?? '';
const getSecondaryKeywords = (entry) => getEntryKeywords(entry).slice(1);
const getKeywordsDisplay = (entry) => getEntryKeywords(entry).join(', ');
const isEntryEnabled = (entry) => entry?.enabled !== false;
const getEntryStorageKey = (entry) => `${entry.scope || 'global'}:${entry.characterKey || ''}:${entry.id}`;
const getSelectedImageSlot = (entry) => settings.selectedImages[getEntryStorageKey(entry)];
const getDisplayedImage = (entry) => {
    const images = getEntryImages(entry);
    const selectedImage = images.find((image) => Number(image.slot) === Number(getSelectedImageSlot(entry)));
    return selectedImage || images[0] || null;
};
function setDisplayedImageSlot(entry, slot) {
    settings.selectedImages[getEntryStorageKey(entry)] = Number(slot);
    saveSettingsDebounced();
}

function deleteDisplayedImageSelection(entry) {
    const storageKey = getEntryStorageKey(entry);
    if (!Object.prototype.hasOwnProperty.call(settings.selectedImages, storageKey)) {
        return;
    }

    delete settings.selectedImages[storageKey];
    saveSettingsDebounced();
}

function reconcileDisplayedImageSelectionAfterDelete(entry, deletedSlot) {
    const storageKey = getEntryStorageKey(entry);
    const currentSlot = Number(settings.selectedImages[storageKey]);
    if (!Number.isFinite(currentSlot)) {
        return;
    }

    if (currentSlot === deletedSlot) {
        settings.selectedImages[storageKey] = Math.max(0, deletedSlot - 1);
        saveSettingsDebounced();
        return;
    }

    if (currentSlot > deletedSlot) {
        settings.selectedImages[storageKey] = currentSlot - 1;
        saveSettingsDebounced();
    }
}

function getCurrentCharacterScopeInfo() {
    const context = getContext();
    if (context.groupId) {
        const group = context.groups.find((item) => String(item.id) === String(context.groupId));
        return { available: true, key: `group:${context.groupId}`, label: group?.name ? `角色卡条目：${group.name}` : '角色卡条目', uploadHint: group?.name ? `当前绑定到群组卡：${group.name}` : '当前绑定到群组卡。' };
    }
    const characterId = context.characterId;
    const character = characterId !== undefined ? context.characters?.[characterId] : null;
    if (!character) {
        return { available: false, key: '', label: '角色卡条目（未选择角色卡）', uploadHint: '未选择角色卡，当前不能保存角色卡条目。' };
    }
    const stableId = character.avatar || String(characterId);
    return { available: true, key: `character:${stableId}`, label: `角色卡条目：${character.name || '当前角色卡'}`, uploadHint: `当前绑定到：${character.name || '当前角色卡'}` };
}

function setServerStatus(message, isError = false) {
    const status = document.getElementById('kit_server_status');
    if (!(status instanceof HTMLElement)) return;
    status.textContent = message || '';
    status.style.color = isError ? 'var(--crimson)' : '';
}

function getHeadersForFormData() {
    const headers = { ...getRequestHeaders() };
    delete headers['Content-Type'];
    return headers;
}

const getAllEntries = () => [...globalEntries, ...characterEntries];
const findEntry = (scope, id, characterKey = '') => (scope === 'global' ? globalEntries : characterEntries).find((entry) => entry.id === id && (scope === 'global' || String(entry.characterKey ?? '') === String(characterKey ?? '')));

function updateScopeUi() {
    const scopeInfo = getCurrentCharacterScopeInfo();
    const scopeSelect = document.getElementById('kit_scope');
    const scopeHint = document.getElementById('kit_scope_hint');
    const characterTitle = document.getElementById('kit_character_list_title');
    if (scopeSelect instanceof HTMLSelectElement) {
        const characterOption = Array.from(scopeSelect.options).find((option) => option.value === 'character');
        if (characterOption) characterOption.disabled = !scopeInfo.available;
        if (!scopeInfo.available && scopeSelect.value === 'character') scopeSelect.value = 'global';
    }
    if (scopeHint instanceof HTMLElement) scopeHint.textContent = scopeInfo.uploadHint;
    if (characterTitle instanceof HTMLElement) characterTitle.textContent = scopeInfo.label;
}

const filterEntries = (entries) => {
    const searchTerm = normalizedText(entrySearchTerm.trim());
    return searchTerm ? entries.filter((entry) => getEntryKeywords(entry).some((keyword) => normalizedText(keyword).includes(searchTerm))) : entries;
};

function buildEntryMeta(entry) {
    const parts = [];
    const aliases = getSecondaryKeywords(entry);
    if (aliases.length) parts.push(aliases.join(', '));
    parts.push(`${getEntryImages(entry).length} 张图片`);
    return parts.join(' · ');
}

function renderEntryList(containerId, sourceEntries, emptyMessage) {
    const container = document.getElementById(containerId);
    if (!(container instanceof HTMLElement)) return;
    const entries = filterEntries(sourceEntries);
    if (!entries.length) {
        container.innerHTML = `<div class="kit-empty">${escapeHtml(emptyMessage)}</div>`;
        return;
    }

    container.innerHTML = entries.map((entry) => {
        const displayedImage = getDisplayedImage(entry);
        return `
            <div class="kit-entry${isEntryEnabled(entry) ? '' : ' kit-entry-disabled'}" title="${escapeHtml(`触发词: ${getKeywordsDisplay(entry)}`)}">
                <img src="${escapeHtml(displayedImage?.imageUrl || '')}" alt="${escapeHtml(getPrimaryKeyword(entry))}" loading="lazy" />
                <div class="kit-entry-main">
                    <div class="kit-entry-keyword">${escapeHtml(getPrimaryKeyword(entry))}</div>
                    <div class="kit-entry-meta">${escapeHtml(buildEntryMeta(entry))}</div>
                </div>
                <div class="kit-entry-actions">
                    <label class="kit-entry-toggle" title="启用条目"><input class="kit-toggle-entry" type="checkbox" data-kit-id="${escapeHtml(entry.id)}" data-kit-scope="${escapeHtml(entry.scope)}" data-kit-character-key="${escapeHtml(entry.characterKey || '')}" ${isEntryEnabled(entry) ? 'checked' : ''} /></label>
                    <button class="menu_button menu_button_icon kit-add-image-entry" type="button" data-kit-id="${escapeHtml(entry.id)}" data-kit-scope="${escapeHtml(entry.scope)}" data-kit-character-key="${escapeHtml(entry.characterKey || '')}" title="追加图片" aria-label="追加图片"><i class="fa-solid fa-plus"></i></button>
                    <button class="menu_button menu_button_icon kit-edit-entry" type="button" data-kit-id="${escapeHtml(entry.id)}" data-kit-scope="${escapeHtml(entry.scope)}" data-kit-character-key="${escapeHtml(entry.characterKey || '')}" title="编辑触发词" aria-label="编辑触发词"><i class="fa-solid fa-pen"></i></button>
                    <button class="menu_button menu_button_icon kit-replace-entry" type="button" data-kit-id="${escapeHtml(entry.id)}" data-kit-scope="${escapeHtml(entry.scope)}" data-kit-character-key="${escapeHtml(entry.characterKey || '')}" title="替换当前显示图片" aria-label="替换当前显示图片"><i class="fa-solid fa-rotate-right"></i></button>
                    <button class="menu_button menu_button_icon kit-delete-entry" type="button" data-kit-id="${escapeHtml(entry.id)}" data-kit-scope="${escapeHtml(entry.scope)}" data-kit-character-key="${escapeHtml(entry.characterKey || '')}" title="删除条目" aria-label="删除条目"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>`;
    }).join('');

    container.querySelectorAll('.kit-toggle-entry').forEach((input) => input.addEventListener('change', () => updateEntryEnabled(input.getAttribute('data-kit-scope'), input.getAttribute('data-kit-id'), input.getAttribute('data-kit-character-key') || '', input.checked)));
    container.querySelectorAll('.kit-add-image-entry').forEach((button) => button.addEventListener('click', () => promptAppendImage(button.getAttribute('data-kit-scope'), button.getAttribute('data-kit-id'), button.getAttribute('data-kit-character-key') || '')));
    container.querySelectorAll('.kit-edit-entry').forEach((button) => button.addEventListener('click', () => promptEditEntry(button.getAttribute('data-kit-scope'), button.getAttribute('data-kit-id'), button.getAttribute('data-kit-character-key') || '')));
    container.querySelectorAll('.kit-replace-entry').forEach((button) => button.addEventListener('click', () => promptReplaceEntry(button.getAttribute('data-kit-scope'), button.getAttribute('data-kit-id'), button.getAttribute('data-kit-character-key') || '')));
    container.querySelectorAll('.kit-delete-entry').forEach((button) => button.addEventListener('click', () => deleteEntry(button.getAttribute('data-kit-scope'), button.getAttribute('data-kit-id'), button.getAttribute('data-kit-character-key') || '')));
}

function renderEntries() {
    updateScopeUi();
    renderEntryList('kit_global_entries', globalEntries, '还没有全局条目。');
    const scopeInfo = getCurrentCharacterScopeInfo();
    renderEntryList('kit_character_entries', characterEntries, scopeInfo.available ? '当前角色卡还没有条目。' : '未选择角色卡。');
}
async function getResponseErrorText(response, featureName = '') {
    const rawText = (await response.text()).trim();
    if (response.status === 404) {
        if (featureName) {
            return 'server plugin 缺少 ' + featureName + ' 路由。请把 plugins/keyword-image-trigger/index.mjs 更新到最新版本后重启 SillyTavern。';
        }
        return 'server plugin 路由不存在。请确认 plugins/keyword-image-trigger 已更新并重启 SillyTavern。';
    }
    if (!rawText) return 'HTTP ' + response.status;
    if (/^\s*<!DOCTYPE html>/i.test(rawText) || /^\s*<html/i.test(rawText)) {
        return 'HTTP ' + response.status;
    }
    return rawText;
}
async function fetchEntries() {
    const scopeInfo = getCurrentCharacterScopeInfo();
    try {
        const url = new URL(`${API_BASE}/entries`, window.location.origin);
        if (scopeInfo.available) url.searchParams.set('characterKey', scopeInfo.key);
        const response = await fetch(url.toString(), { headers: getRequestHeaders() });
        if (!response.ok) throw new Error(await getResponseErrorText(response, 'GET /entries'));
        const payload = await response.json();
        globalEntries = Array.isArray(payload.globalEntries) ? payload.globalEntries : [];
        characterEntries = Array.isArray(payload.characterEntries) ? payload.characterEntries : [];
        serverAvailable = true;
        setServerStatus('Server plugin 已连接。');
    } catch (error) {
        globalEntries = [];
        characterEntries = [];
        serverAvailable = false;
        setServerStatus('未连接到 server plugin。请确认已安装 plugins/keyword-image-trigger 并在 config.yaml 中启用 enableServerPlugins。', true);
        if (!serverWarningShown) {
            serverWarningShown = true;
            toastr.warning('Keyword Image Trigger 需要 server plugin 才能上传和读取图片。');
        }
    }
    renderEntries();
    scanVisibleMessages();
}

function isWithinDisplayDepth(messageId) {
    if (settings.displayDepth <= 0) return false;
    const targetId = Number(messageId);
    const lastMessageId = chat.length - 1;
    if (!Number.isFinite(targetId) || targetId < 0 || lastMessageId < 0) return false;
    return targetId >= Math.max(0, lastMessageId - settings.displayDepth + 1) && targetId <= lastMessageId;
}

function findTriggeredEntries(messageId) {
    const allEntries = getAllEntries();
    if (!settings.enabled || !allEntries.length) return [];
    const targetId = Number(messageId);
    if (!Number.isFinite(targetId) || targetId < 0) return [];
    const combinedText = normalizedText(chat.slice(Math.max(0, targetId - settings.detectionDepth + 1), targetId + 1).map((message) => {
        if (!message) return '';
        const displayText = message.extra?.display_text ?? '';
        return `${message.name ?? ''}\n${displayText}\n${message.mes ?? ''}`;
    }).join('\n'));
    return allEntries.filter((entry) => isEntryEnabled(entry) && getEntryKeywords(entry).some((keyword) => combinedText.includes(normalizedText(keyword))));
}

function closeImagePreview(immediate = false) {
    const preview = document.getElementById(PREVIEW_ID);
    if (!(preview instanceof HTMLElement)) return;
    if (immediate) return preview.remove();
    $(preview).fadeOut(PREVIEW_ANIMATION_MS, () => preview.remove());
}

const closeImagePicker = () => {
    document.documentElement.classList.remove('kit-image-picker-open');
    document.body.classList.remove('kit-image-picker-open');
    document.getElementById(IMAGE_PICKER_ID)?.remove();

    const popup = imagePickerPopup;
    imagePickerPopup = null;
    if (popup) {
        void popup.complete(null).catch(() => {});
    }
};

function openImagePreview(entry) {
    closeImagePreview(true);
    const displayedImage = getDisplayedImage(entry);
    if (!displayedImage) return;
    const template = $('#zoomed_avatar_template').html();
    if (!template) return window.open(displayedImage.imageUrl, '_blank', 'noopener');
    const preview = $(template);
    preview.attr('id', PREVIEW_ID).attr('data-kit-preview', 'true').addClass('draggable');
    preview.find('.drag-grabber').attr('id', `${PREVIEW_ID}header`);
    const image = preview.find('.zoomed_avatar_img');
    image.attr('src', displayedImage.imageUrl).attr('alt', getPrimaryKeyword(entry));
    $('body').append(preview);
    preview.hide().css('display', 'flex').fadeIn(PREVIEW_ANIMATION_MS);
    dragElement(preview);
    preview.on('click touchend', (event) => {
        const target = event.target;
        if (target instanceof Element && (target.closest('.dragClose') || target === preview.get(0))) closeImagePreview();
    });
    image.on('dragstart', (event) => { event.preventDefault(); return false; });
}

function openImagePicker(entry) {
    closeImagePicker();
    const images = getEntryImages(entry);
    if (images.length <= 1) return;

    const panel = document.createElement('div');
    panel.id = IMAGE_PICKER_ID;
    panel.className = 'kit-image-picker-panel';

    const header = document.createElement('div');
    header.className = 'kit-image-picker-header';

    const title = document.createElement('div');
    title.className = 'kit-image-picker-title';
    title.textContent = `选择 ${getPrimaryKeyword(entry)} 的显示图片`;

    const closeButton = document.createElement('button');
    closeButton.className = 'menu_button menu_button_icon';
    closeButton.type = 'button';
    closeButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';

    const grid = document.createElement('div');
    grid.className = 'kit-image-picker-grid';
    const selectedSlot = getDisplayedImage(entry)?.slot;

    const popup = new Popup(panel, POPUP_TYPE.TEXT, '', {
        okButton: '关闭',
        cancelButton: false,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        animation: 'fast',
        onOpen: () => {
            popup.dlg.classList.add('kit-image-picker-popup');
            document.documentElement.classList.add('kit-image-picker-open');
            document.body.classList.add('kit-image-picker-open');
        },
        onClose: () => {
            if (imagePickerPopup === popup) {
                imagePickerPopup = null;
            }
            document.documentElement.classList.remove('kit-image-picker-open');
            document.body.classList.remove('kit-image-picker-open');
        },
    });

    closeButton.addEventListener('click', () => {
        if (imagePickerPopup === popup) {
            imagePickerPopup = null;
        }
        void popup.complete(null).catch(() => {});
    });

    for (const image of images) {
        const card = document.createElement('div');
        card.className = 'kit-image-picker-card';

        const item = document.createElement('button');
        item.type = 'button';
        item.className = `kit-image-picker-item${Number(image.slot) === Number(selectedSlot) ? ' is-selected' : ''}`;

        const thumb = document.createElement('img');
        thumb.className = 'kit-image-picker-thumb';
        thumb.src = image.imageUrl;
        thumb.alt = `${getPrimaryKeyword(entry)} ${image.slot}`;

        const label = document.createElement('div');
        label.className = 'kit-image-picker-slot';
        label.textContent = image.slot === 0 ? '默认图' : `图片 ${image.slot}`;

        item.addEventListener('click', () => {
            setDisplayedImageSlot(entry, image.slot);
            if (imagePickerPopup === popup) {
                imagePickerPopup = null;
            }
            void popup.complete(null).catch(() => {});
            renderEntries();
            scanVisibleMessages();
        });

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'menu_button menu_button_icon kit-image-picker-delete';
        deleteButton.title = image.slot === 0 && images.length === 1 ? '删除最后一张图片并移除条目' : '删除这张图片';
        deleteButton.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        deleteButton.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await deleteEntryImage(entry, image.slot, popup);
        });

        item.append(thumb, label);
        card.append(item, deleteButton);
        grid.appendChild(card);
    }

    header.append(title, closeButton);
    panel.append(header, grid);
    imagePickerPopup = popup;
    void popup.show();
}
function installInlineScrollGuard(element) {
    let touchStartX = 0;
    let touchStartY = 0;
    element.addEventListener('touchstart', (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
    }, { passive: true });
    element.addEventListener('touchmove', (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        if (Math.abs(touch.clientX - touchStartX) > Math.abs(touch.clientY - touchStartY)) event.stopPropagation();
    }, { passive: true });
    element.addEventListener('pointerdown', (event) => event.stopPropagation());
    element.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
}

function renderInlineImages(messageId) {
    const mesText = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!(mesText instanceof HTMLElement)) return;
    mesText.querySelector(`:scope > .${INLINE_CONTAINER_CLASS}`)?.remove();
    if (!settings.enabled || !serverAvailable || !isWithinDisplayDepth(messageId)) return;
    const matchedEntries = findTriggeredEntries(messageId);
    if (!matchedEntries.length) return;
    const wrapper = document.createElement('div');
    wrapper.className = INLINE_CONTAINER_CLASS;
    installInlineScrollGuard(wrapper);
    for (const entry of matchedEntries) {
        const displayedImage = getDisplayedImage(entry);
        if (!displayedImage) continue;
        const card = document.createElement('div');
        card.className = 'kit-inline-card';
        card.style.backgroundColor = settings.cardBackgroundColor;
        card.style.setProperty('--kit-inline-width', `${settings.imageMaxWidth}px`);
        const media = document.createElement('div');
        media.className = 'kit-inline-media';
        if (getEntryImages(entry).length > 1) {
            const switchButton = document.createElement('button');
            switchButton.className = 'menu_button menu_button_icon kit-inline-select-button';
            switchButton.type = 'button';
            switchButton.title = '切换图片';
            switchButton.innerHTML = '<i class="fa-solid fa-table-cells-large"></i>';
            switchButton.addEventListener('click', (event) => { event.stopPropagation(); openImagePicker(entry); });
            media.appendChild(switchButton);
        }
        const button = document.createElement('button');
        button.className = 'kit-inline-image-button';
        button.type = 'button';
        button.title = `查看 ${getPrimaryKeyword(entry)}`;
        const image = document.createElement('img');
        image.className = 'kit-inline-image';
        image.src = displayedImage.imageUrl;
        image.alt = getPrimaryKeyword(entry);
        image.loading = 'lazy';
        image.style.maxWidth = `${settings.imageMaxWidth}px`;
        image.style.width = 'auto';
        image.style.height = 'auto';
        const title = document.createElement('div');
        title.className = 'kit-inline-trigger';
        title.textContent = getPrimaryKeyword(entry);
        button.addEventListener('click', () => openImagePreview(entry));
        button.appendChild(image);
        media.appendChild(button);
        card.append(media, title);
        wrapper.appendChild(card);
    }
    if (wrapper.children.length > 0) mesText.appendChild(wrapper);
}

function scanVisibleMessages() {
    closeImagePicker();
    document.querySelectorAll('#chat .mes[mesid]').forEach((element) => {
        const messageId = element.getAttribute('mesid');
        if (messageId !== null) renderInlineImages(messageId);
    });
}
function getSelectedUploadTarget() {
    const scopeSelect = document.getElementById('kit_scope');
    const selectedScope = scopeSelect instanceof HTMLSelectElement ? scopeSelect.value : 'character';
    const scopeInfo = getCurrentCharacterScopeInfo();
    if (selectedScope === 'global') return { scope: 'global', characterKey: '' };
    if (!scopeInfo.available) return null;
    return { scope: 'character', characterKey: scopeInfo.key };
}

async function submitEntryImage(rawKeywordInput, file, target, successMessage, failurePrefix) {
    const formData = new FormData();
    formData.append('keyword', rawKeywordInput);
    formData.append('scope', target.scope);
    if (target.scope === 'character') formData.append('characterKey', target.characterKey);
    formData.append('avatar', file);
    try {
        const response = await fetch(`${API_BASE}/entries`, { method: 'POST', headers: getHeadersForFormData(), body: formData });
        if (!response.ok) throw new Error(await getResponseErrorText(response));
        toastr.success(successMessage);
        await fetchEntries();
        return true;
    } catch (error) {
        toastr.error(`${failurePrefix}：${error.message}`);
        return false;
    }
}

async function appendEntryImage(scope, id, characterKey, file) {
    const formData = new FormData();
    formData.append('scope', scope);
    if (scope === 'character') formData.append('characterKey', characterKey);
    formData.append('avatar', file);
    try {
        const response = await fetch(`${API_BASE}/entries/${encodeURIComponent(id)}/images`, { method: 'POST', headers: getHeadersForFormData(), body: formData });
        if (!response.ok) throw new Error(await getResponseErrorText(response, 'POST /entries/:id/images'));
        toastr.success('图片已追加。');
        await fetchEntries();
    } catch (error) {
        toastr.error(`追加图片失败：${error.message}`);
    }
}
async function deleteEntryImage(entry, slot, popup = null) {
    try {
        const url = new URL(`${API_BASE}/entries/${encodeURIComponent(entry.id)}/images/${encodeURIComponent(slot)}`, window.location.origin);
        url.searchParams.set('scope', entry.scope || 'global');
        if (entry.scope === 'character') url.searchParams.set('characterKey', entry.characterKey || '');
        const response = await fetch(url.toString(), { method: 'DELETE', headers: getRequestHeaders() });
        if (!response.ok) throw new Error(await getResponseErrorText(response, 'DELETE /entries/:id/images/:slot'));

        const payload = await response.json();
        if (payload?.deletedEntry) {
            deleteDisplayedImageSelection(entry);
        } else {
            reconcileDisplayedImageSelectionAfterDelete(entry, Number(payload?.deletedSlot ?? slot));
        }

        if (popup && imagePickerPopup === popup) {
            imagePickerPopup = null;
            void popup.complete(null).catch(() => {});
        }

        await fetchEntries();
        const updatedEntry = payload?.deletedEntry ? null : findEntry(entry.scope, entry.id, entry.characterKey);
        if (updatedEntry && getEntryImages(updatedEntry).length > 1) {
            openImagePicker(updatedEntry);
        }

        toastr.success(payload?.deletedEntry ? '最后一张图片已删除，条目也已移除。' : '图片已删除。');
    } catch (error) {
        toastr.error(`删除图片失败：${error.message}`);
    }
}
async function replaceEntryImage(scope, id, characterKey, file) {
    const entry = findEntry(scope, id, characterKey);
    const displayedImage = entry ? getDisplayedImage(entry) : null;
    if (!entry) return toastr.warning('未找到要替换的条目。');
    if (!displayedImage) return toastr.warning('未找到要替换的图片。');
    if (!file) return toastr.warning('请先选择一张图片。');
    const formData = new FormData();
    formData.append('scope', scope);
    if (scope === 'character') formData.append('characterKey', characterKey);
    formData.append('avatar', file);
    try {
        const response = await fetch(`${API_BASE}/entries/${encodeURIComponent(id)}/images/${encodeURIComponent(displayedImage.slot)}`, { method: 'POST', headers: getHeadersForFormData(), body: formData });
        if (!response.ok) throw new Error(await getResponseErrorText(response, 'POST /entries/:id/images/:slot'));
        toastr.success(`已替换 ${getPrimaryKeyword(entry)} 的当前图片。`);
        await fetchEntries();
    } catch (error) {
        toastr.error(`替换失败：${error.message}`);
    }
}
async function updateEntry(scope, id, characterKey, payload, successMessage, failurePrefix) {
    try {
        const response = await fetch(`${API_BASE}/entries/${encodeURIComponent(id)}`, { method: 'PUT', headers: getRequestHeaders(), body: JSON.stringify({ ...payload, scope, characterKey }) });
        if (!response.ok) throw new Error(await getResponseErrorText(response));
        toastr.success(successMessage);
        await fetchEntries();
    } catch (error) {
        toastr.error(`${failurePrefix}：${error.message}`);
    }
}

function promptForImageFile(callback) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.style.display = 'none';
    picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        picker.remove();
        if (file) await callback(file);
    }, { once: true });
    document.body.appendChild(picker);
    picker.click();
}

const promptAppendImage = (scope, id, characterKey) => promptForImageFile((file) => appendEntryImage(scope, id, characterKey, file));
const promptReplaceEntry = (scope, id, characterKey) => promptForImageFile((file) => replaceEntryImage(scope, id, characterKey, file));

function promptEditEntry(scope, id, characterKey) {
    const entry = findEntry(scope, id, characterKey);
    if (!entry) return toastr.warning('未找到要编辑的条目。');
    const nextKeywords = window.prompt('编辑触发词，使用英文逗号分隔多个词。第一项会作为主词。', getKeywordsDisplay(entry));
    if (nextKeywords === null) return;
    const trimmedKeywords = nextKeywords.trim();
    if (!trimmedKeywords) return toastr.warning('触发词不能为空。');
    updateEntry(scope, id, characterKey, { keyword: trimmedKeywords }, '触发词已更新。', '编辑触发词失败');
}

const updateEntryEnabled = (scope, id, characterKey, enabled) => updateEntry(scope, id, characterKey, { enabled }, enabled ? '条目已启用。' : '条目已禁用。', '切换状态失败');

async function deleteEntry(scope, id, characterKey) {
    try {
        const url = new URL(`${API_BASE}/entries/${encodeURIComponent(id)}`, window.location.origin);
        url.searchParams.set('scope', scope);
        if (scope === 'character') url.searchParams.set('characterKey', characterKey);
        const response = await fetch(url.toString(), { method: 'DELETE', headers: getRequestHeaders() });
        if (!response.ok) throw new Error(await getResponseErrorText(response));
        toastr.success('条目已删除。');
        await fetchEntries();
    } catch (error) {
        toastr.error(`删除失败：${error.message}`);
    }
}

async function uploadEntry() {
    const keywordInput = document.getElementById('kit_keyword');
    const fileInput = document.getElementById('kit_file');
    const fileName = document.getElementById('kit_file_name');
    if (!(keywordInput instanceof HTMLInputElement) || !(fileInput instanceof HTMLInputElement) || !(fileName instanceof HTMLElement)) return;
    const rawKeywordInput = keywordInput.value.trim();
    const file = fileInput.files?.[0];
    const target = getSelectedUploadTarget();
    if (!rawKeywordInput) return toastr.warning('请先输入触发词。');
    if (!target) return toastr.warning('当前没有角色卡，不能保存角色卡条目。');
    if (!file) return toastr.warning('请先选择一张图片。');
    const uploaded = await submitEntryImage(rawKeywordInput, file, target, '图片已上传。', '上传失败');
    if (!uploaded) return;
    keywordInput.value = '';
    fileInput.value = '';
    fileName.textContent = '未选择文件';
}
function bindSettings() {
    const enabledInput = document.getElementById('kit_enabled');
    const depthInput = document.getElementById('kit_depth');
    const displayDepthInput = document.getElementById('kit_display_depth');
    const maxWidthInput = document.getElementById('kit_max_width');
    const bgColorInput = document.getElementById('kit_bg_color');
    const fileInput = document.getElementById('kit_file');
    const fileName = document.getElementById('kit_file_name');
    const entrySearchInput = document.getElementById('kit_entry_search');
    const uploadButton = document.getElementById('kit_upload');
    const refreshButton = document.getElementById('kit_refresh');

    if (!(enabledInput instanceof HTMLInputElement)
        || !(depthInput instanceof HTMLInputElement)
        || !(displayDepthInput instanceof HTMLInputElement)
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
    displayDepthInput.value = String(settings.displayDepth);
    maxWidthInput.value = String(settings.imageMaxWidth);
    bgColorInput.value = settings.cardBackgroundColor;
    fileName.textContent = fileInput.files?.[0]?.name || '未选择文件';
    entrySearchInput.value = entrySearchTerm;
    updateScopeUi();

    enabledInput.addEventListener('change', () => {
        settings.enabled = enabledInput.checked;
        saveSettingsDebounced();
        scanVisibleMessages();
    });
    depthInput.addEventListener('change', () => {
        settings.detectionDepth = clampInteger(depthInput.value, 1, 50, defaultSettings.detectionDepth);
        depthInput.value = String(settings.detectionDepth);
        saveSettingsDebounced();
        scanVisibleMessages();
    });
    displayDepthInput.addEventListener('change', () => {
        settings.displayDepth = clampInteger(displayDepthInput.value, 0, 50, defaultSettings.displayDepth);
        displayDepthInput.value = String(settings.displayDepth);
        saveSettingsDebounced();
        scanVisibleMessages();
    });
    maxWidthInput.addEventListener('change', () => {
        settings.imageMaxWidth = clampInteger(maxWidthInput.value, 80, 1200, defaultSettings.imageMaxWidth);
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

const scheduleVisibleScan = () => window.setTimeout(scanVisibleMessages, 0);
const handleChatChanged = () => window.setTimeout(fetchEntries, 0);

eventSource.on(event_types.APP_READY, initUi);
eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
eventSource.on(event_types.MESSAGE_UPDATED, scheduleVisibleScan);
eventSource.on(event_types.MESSAGE_SWIPED, scheduleVisibleScan);
eventSource.on(event_types.MESSAGE_DELETED, scheduleVisibleScan);
eventSource.on(event_types.USER_MESSAGE_RENDERED, scheduleVisibleScan);
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, scheduleVisibleScan);
