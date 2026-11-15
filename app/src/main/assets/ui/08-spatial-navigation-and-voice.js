function scrollStripToCard(strip, card) {
  if (!strip || !card) return;
  const sRect = strip.getBoundingClientRect();
  const cRect = card.getBoundingClientRect();
  if (cRect.left < sRect.left + 90) {
    strip.scrollBy({ left: cRect.left - sRect.left - 90, behavior: 'smooth' });
  } else if (cRect.right > sRect.right - 90) {
    strip.scrollBy({ left: cRect.right - sRect.right + 90, behavior: 'smooth' });
  }
}

// 11. TV REMOTE KEY LISTENER & SPATIAL ENGINE
function setupMouseHoverFocus() {
  document.addEventListener('mouseover', (e) => {
    const focusable = e.target.closest('.tv-focusable');
    if (focusable && document.activeElement !== focusable) {
      focusable.focus({ preventScroll: true });
    }
  });
}

window.handleTvKeyLongPress = function(k, code) {
  console.log('[TV-LONG-PRESS]', k, code, 'active:', (document.activeElement?.className || document.activeElement?.id));
  const cur = document.activeElement;
  if (!cur) return;
  if (cur.classList.contains('is-history') || cur.closest('.is-history')) {
    const item = cur.classList.contains('is-history') ? cur : cur.closest('.is-history');
    const q = item.getAttribute('data-query');
    if (q) {
      historyLongPressTriggered = true;
      openDeleteHistoryModal(q);
    }
  }
};

window.handleTvKeyEvent = function(k, code) {
  console.log('[TV-NAV]', k, code, 'active:', (document.activeElement?.className || document.activeElement?.id || document.activeElement?.tagName));
  const curTag = document.activeElement ? document.activeElement.tagName : '';
  const isInputActive = curTag === 'INPUT' || curTag === 'TEXTAREA';

  // Backspace key inside inputs deletes characters instead of exiting
  if (code === 8 && isInputActive) {
    const input = document.activeElement;
    if (input && !input.readOnly) {
      const val = input.value || '';
      const start = input.selectionStart ?? val.length;
      const end = input.selectionEnd ?? val.length;
      if (start !== end) {
        input.value = val.slice(0, start) + val.slice(end);
        input.setSelectionRange(start, start);
      } else if (start > 0) {
        input.value = val.slice(0, start - 1) + val.slice(start);
        input.setSelectionRange(start - 1, start - 1);
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  const isLeft = k === 'ArrowLeft' || code === 37 || k === 'Left';
  const isRight = k === 'ArrowRight' || code === 39 || k === 'Right';
  const isUp = k === 'ArrowUp' || code === 38 || k === 'Up';
  const isDown = k === 'ArrowDown' || code === 40 || k === 'Down';
  const isEnter = k === 'Enter' || code === 13 || k === 'Select';
  const isBack = k === 'Escape' || code === 27 || k === 'Back' || k === 'GoBack' || code === 10009 || code === 4 || (code === 8 && !isInputActive);

  // 1. Web Player Overlay
  const pOv = document.getElementById('playerOverlay');
  if (pOv && pOv.style.display === 'flex') {
    if (isRight) seekDelta(10);
    else if (isLeft) seekDelta(-10);
    else if (isEnter || k === ' ' || k === 'MediaPlayPause') togglePlayPause();
    else if (isDown || isUp) resetOsdTimer();
    else if (isBack) exitPlayer();
    return true;
  }

  // 2. Escape / Back Key
  if (isBack) {
    return window.handleAppBackKey();
  }

  // 3. Arrow Keys D-Pad Spatial Navigation
  if (isUp || isDown || isLeft || isRight) {
    const cur = document.activeElement;
    if (cur && (cur.tagName === 'INPUT' || cur.tagName === 'TEXTAREA') && !cur.readOnly) {
      if (isLeft || isRight) return false;
    }
    const dir = isUp ? 'ArrowUp' : isDown ? 'ArrowDown' : isLeft ? 'ArrowLeft' : 'ArrowRight';
    navigateSpatial(dir);
    return true;
  }

  // 4. Enter / OK Button
  if (isEnter) {
    const cur = document.activeElement;
    if (cur) {
      if (cur.classList && cur.classList.contains('is-history')) {
        // Suppress synchronous click on keydown! Keyup executes short tap vs long-press
        return true;
      }
      if (cur.tagName === 'INPUT' || cur.tagName === 'TEXTAREA') {
        if (cur.readOnly) {
          if (cur.id === 'filterSearchInput') {
            onSearchInputClicked(cur);
          } else {
            cur.removeAttribute('readonly');
            cur.focus();
          }
          return true;
        } else {
          if (advanceToNextInput(cur)) return true;
        }
      }
      if (cur.classList.contains('tv-focusable') || cur.tagName === 'BUTTON') {
        cur.click();
        return true;
      }
    }
  }
  return false;
};

let lastRemoteKeyTime = 0;
let keyboardNavInstalled = false;
function setupKeyboardNavigation() {
  // Called after sign-in, profile switch, etc. Registering twice made every key press act twice.
  if (keyboardNavInstalled) return;
  keyboardNavInstalled = true;
  window.addEventListener('keydown', (e) => {
    const isEnter = e.key === 'Enter' || e.keyCode === 13 || e.key === 'Select';
    if (isEnter) {
      const cur = document.activeElement;
      if (cur && cur.classList && cur.classList.contains('is-history')) {
        if (!e.repeat && !historyLongPressTimer) {
          historyLongPressTriggered = false;
          historyLongPressTimer = setTimeout(() => {
            historyLongPressTriggered = true;
            historyLongPressTimer = null;
            const q = cur.getAttribute('data-query');
            if (q) openDeleteHistoryModal(q);
          }, 550);
        }
        if (e.repeat) {
          e.preventDefault();
          return;
        }
      }
    }
    const nowKeyTime = performance.now();
    if (e.repeat && (nowKeyTime - lastRemoteKeyTime < 65)) {
      e.preventDefault();
      return;
    }
    lastRemoteKeyTime = nowKeyTime;
    const handled = window.handleTvKeyEvent(e.key, e.keyCode);
    if (handled) e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    const isEnter = e.key === 'Enter' || e.keyCode === 13 || e.key === 'Select';
    if (isEnter) {
      const cur = document.activeElement;
      if (cur && cur.classList && cur.classList.contains('is-history')) {
        if (historyLongPressTimer) {
          clearTimeout(historyLongPressTimer);
          historyLongPressTimer = null;
        }
        if (historyLongPressTriggered) {
          historyLongPressTriggered = false;
          e.preventDefault();
          return;
        }
        const q = cur.getAttribute('data-query');
        if (q) applySearchSuggestion(q);
        e.preventDefault();
        return;
      }
      if (historyLongPressTimer) {
        clearTimeout(historyLongPressTimer);
        historyLongPressTimer = null;
      }
    }
  });

  window.addEventListener('focusin', (e) => {
    if (e.target && typeof e.target.scrollIntoView === 'function' && !e.target.closest?.('.sidebar')) {
tvScrollIntoView(e.target, { block: 'nearest', inline: 'nearest' });
    }
  });
}

function navigateSpatial(key) {
  const current = document.activeElement;
  // Display name: Up goes to the ACTIVE profile box (the nearest box used to be "Add Profile")
  if (key === 'ArrowUp' && current && current.id === 'profNameInput') {
    const cards = Array.from(document.querySelectorAll('.profile-card-item')).filter((c) => !(c.getAttribute('onclick') || '').includes('promptAddNewProfile'));
    const act = document.querySelector('.profile-card-item.is-active-profile') || cards[0];
    if (act) { act.focus(); playNavSound(); return; }
  }
  if (current && fastNavigate(current, key)) {
    return;
  }

  let container = document;
  if (activeDropdownId && document.getElementById(activeDropdownId) && document.getElementById(activeDropdownId).style.display === 'block') {
    container = document.getElementById(activeDropdownId);
  } else if (getTopPopup()) {
    container = getTopPopup();
  } else if (document.getElementById('playlistModal') && document.getElementById('playlistModal').style.display === 'flex') {
    container = document.getElementById('playlistModal');
  } else if (document.getElementById('cloudAuthModal') && document.getElementById('cloudAuthModal').style.display === 'flex') {
    container = document.getElementById('cloudAuthModal');
  } else if (document.getElementById('profilePickerOverlay') && document.getElementById('profilePickerOverlay').style.display === 'flex') {
    container = document.getElementById('profilePickerOverlay');
  } else if (document.getElementById('welcomeScreenOverlay') && document.getElementById('welcomeScreenOverlay').style.display === 'flex') {
    container = document.getElementById('welcomeScreenOverlay');
  } else if (document.getElementById('factoryResetModal') && document.getElementById('factoryResetModal').style.display === 'flex') {
    container = document.getElementById('factoryResetModal');
  } else if (document.getElementById('userProfileModal') && document.getElementById('userProfileModal').style.display === 'flex') {
    container = document.getElementById('userProfileModal');
  } else if (document.getElementById('detailOverlay') && document.getElementById('detailOverlay').style.display !== 'none') {
    container = document.getElementById('detailOverlay');
  } else if (document.getElementById('addProfileModal') && document.getElementById('addProfileModal').style.display === 'flex') {
    container = document.getElementById('addProfileModal');
  } else if (document.getElementById('deleteProfileModal') && document.getElementById('deleteProfileModal').style.display === 'flex') {
    container = document.getElementById('deleteProfileModal');
  } else if (document.getElementById('signOutModal') && document.getElementById('signOutModal').style.display === 'flex') {
    container = document.getElementById('signOutModal');
  } else if (document.getElementById('deleteHistoryModal') && document.getElementById('deleteHistoryModal').style.display === 'flex') {
    container = document.getElementById('deleteHistoryModal');
  } else if (document.getElementById('clearAllHistoryModal') && document.getElementById('clearAllHistoryModal').style.display === 'flex') {
    container = document.getElementById('clearAllHistoryModal');
  } else if (document.getElementById('parentalPinModal') && document.getElementById('parentalPinModal').style.display === 'flex') {
    container = document.getElementById('parentalPinModal');
  } else if (document.getElementById('voiceSearchModal') && document.getElementById('voiceSearchModal').style.display === 'flex') {
    container = document.getElementById('voiceSearchModal');
  }

  const focusables = Array.from(container.querySelectorAll('.tv-focusable, input, button'))
    .filter(el => {
      if (el.disabled || el.style.display === 'none' || el.getAttribute('tabindex') === '-1') return false;
      if (el.offsetParent === null && el.getClientRects().length === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

  if (focusables.length === 0) return;

  if (!current || !focusables.includes(current)) {
    focusables[0].focus();
    playNavSound();
    return;
  }

  const cRect = current.getBoundingClientRect();
  const cCenter = { x: cRect.left + cRect.width / 2, y: cRect.top + cRect.height / 2 };
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';

  // Industry-standard direction search (like Android's focus finder):
  //  1. only boxes that lie wholly in that direction count (edge to edge, not centre to centre),
  //  2. among those the nearest wins, boxes that line up with the current one count as a bit closer.
  // This is what makes "Right" go to the right-hand box instead of walking down the left-hand column.
  const R = (el) => el.getBoundingClientRect();
  let bestCandidate = null;
  let bestSide = Infinity;
  let sideCandidate = null;
  for (const el of focusables) {
    if (el === current) continue;
    const e = R(el);
    let gap;
    if (key === 'ArrowRight') gap = e.left - cRect.right;
    else if (key === 'ArrowLeft') gap = cRect.left - e.right;
    else if (key === 'ArrowDown') gap = e.top - cRect.bottom;
    else gap = cRect.top - e.bottom;
    if (gap < -2) continue;                       // not wholly in that direction
    gap = Math.max(0, gap);
    const overlap = vertical
      ? Math.min(cRect.right, e.right) - Math.max(cRect.left, e.left)
      : Math.min(cRect.bottom, e.bottom) - Math.max(cRect.top, e.top);
    const eCenter = { x: e.left + e.width / 2, y: e.top + e.height / 2 };
    const orthoCenter = vertical ? Math.abs(eCenter.x - cCenter.x) : Math.abs(eCenter.y - cCenter.y);
    // nearest first, boxes in line with the current one count as closer; the same weighting the screens were tuned with
    const score = gap + orthoCenter * (overlap > 4 ? 1.6 : 2.2);
    if (score < bestSide) { bestSide = score; sideCandidate = el; }
  }
  if (!bestCandidate) bestCandidate = sideCandidate;
  if (!bestCandidate) {
    // nothing wholly in that direction (for example boxes that overlap): the old centre-to-centre rule as a last resort
    let minScore = Infinity;
    for (const el of focusables) {
      if (el === current) continue;
      const eRect = R(el);
      const dx = eRect.left + eRect.width / 2 - cCenter.x;
      const dy = eRect.top + eRect.height / 2 - cCenter.y;
      if (key === 'ArrowUp' && dy >= -4) continue;
      if (key === 'ArrowDown' && dy <= 4) continue;
      if (key === 'ArrowLeft' && dx >= -4) continue;
      if (key === 'ArrowRight' && dx <= 4) continue;
      const score = (vertical ? Math.abs(dy) : Math.abs(dx)) + (vertical ? Math.abs(dx) : Math.abs(dy)) * 2.2;
      if (score < minScore) { minScore = score; bestCandidate = el; }
    }
  }

  // Left from content: only another box in the same row counts. Otherwise the remote goes to the sidebar entry
  // of the tab that is open (Home, Movies... or Settings / Profile), never to some other sidebar button.
  if (key === 'ArrowLeft' && current && !current.closest('.sidebar') && container === document) {
    const inContent = bestCandidate && !bestCandidate.closest('.sidebar') && document.getElementById('mainViewport')?.contains(bestCandidate);
    let sameRow = false;
    if (inContent) {
      const br = R(bestCandidate);
      sameRow = Math.min(cRect.bottom, br.bottom) - Math.max(cRect.top, br.top) > 4;
    }
    if (!sameRow) bestCandidate = getActiveSidebarElement() || bestCandidate;
  }

  if (bestCandidate) {
    bestCandidate.focus();
    playNavSound();

    const strip = bestCandidate.closest('.poster-strip');
    if (strip) {
      scrollStripToCard(strip, bestCandidate);
    } else {
tvScrollIntoView(bestCandidate, { block: 'nearest', inline: 'nearest' });
    }
  }
}

function openVoiceSearchModal() {
  const modal = document.getElementById('voiceSearchModal');
  const title = document.getElementById('voiceSearchStatusTitle');
  const text = document.getElementById('voiceSearchStatusText');
  if (title) title.innerText = 'Listening...';
  if (text) text.innerText = 'Say a movie, series, genre or actor name.';
  if (modal) {
    modal.style.display = 'flex';
    const cancelBtn = document.getElementById('btnCancelVoiceSearch');
    if (cancelBtn) cancelBtn.focus();
  }
}

function closeVoiceSearchModal() {
  const modal = document.getElementById('voiceSearchModal');
  if (modal) modal.style.display = 'none';
  const voiceBtn = document.getElementById('btnVoiceSearch') || document.getElementById('filterSearchBtn');
  if (voiceBtn) voiceBtn.focus();
}

window.onVoiceSearchError = function(msg) {
  const title = document.getElementById('voiceSearchStatusTitle');
  const text = document.getElementById('voiceSearchStatusText');
  if (title) title.innerText = 'Voice Search Unavailable';
  if (text) text.innerText = msg || 'Voice search is not supported on this remote. Use the on-screen keyboard.';
  setTimeout(closeVoiceSearchModal, 2200);
};

function startVoiceSearch() {
  playNavSound();
  openVoiceSearchModal();
  if (window.AndroidApp && typeof window.AndroidApp.startVoiceInput === 'function') {
    window.AndroidApp.startVoiceInput();
    return;
  }
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    window.onVoiceSearchError('Voice input is not supported in this browser environment.');
    return;
  }
  try {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new Rec();
    recognition.lang = 'en-US';
    recognition.onresult = (e) => {
      const text = e.results[0][0].transcript;
      closeVoiceSearchModal();
      window.onVoiceSearchResult(text);
    };
    recognition.onerror = () => {
      window.onVoiceSearchError('Could not recognize audio. Please try again.');
    };
    recognition.start();
  } catch (err) {
    window.onVoiceSearchError(err.message);
  }
}

window.onVoiceSearchResult = function(text) {
  closeVoiceSearchModal();
  if (!text) return;
  const inp = document.getElementById('filterSearchInput');
  if (inp) {
    inp.value = text;
    filterState.searchQuery = text;
    dismissSuggestions();
    executeFilterQuery();
  }
};

