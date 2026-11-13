async function loadLiveTv(vp) {
  vp.innerHTML = `
    <div class="live-view-container">
      <div style="display:flex;gap:12px;margin-bottom:14px;max-width:900px;">
        <input id="liveSearchInput" class="search-field tv-focusable"
               readonly
               onclick="this.removeAttribute('readonly');this.focus();"
               onblur="this.setAttribute('readonly','true');"
               value="${escapeHtml(currentLiveSearch)}"
               placeholder="Search 3,000 live channels by name or sport..."
               oninput="onLiveSearchInput(this.value)" />
      </div>
      <div class="live-tab-bar" id="liveTabBar">Loading tabs...</div>
      <div class="live-grid" id="liveGrid">Loading channels...</div>
    </div>
  `;
  await fetchLiveChannels();
}

function onLiveSearchInput(val) {
  currentLiveSearch = val;
  if (queryDebounceTimer) clearTimeout(queryDebounceTimer);
  queryDebounceTimer = setTimeout(fetchLiveChannels, 200);
}

function selectLiveTab(tabId) {
  playNavSound();
  currentLiveTab = tabId;
  const tabContainer = document.getElementById('liveTabBar');
  if (tabContainer) {
    const btns = tabContainer.querySelectorAll('.live-tab-btn');
    btns.forEach(b => {
      const isTarget = b.getAttribute('data-tab-id') === tabId;
      if (isTarget) {
        b.classList.add('active');
        b.focus();
      } else {
        b.classList.remove('active');
      }
    });
  }
  fetchLiveChannels(false);
}

async function fetchLiveChannels(rebuildTabs = true) {
  const tabContainer = document.getElementById('liveTabBar');
  const grid = document.getElementById('liveGrid');
  if (!grid) return;

  const liveGroup = currentTab === 'VAULT_18' ? 'adult' : currentTab === 'EXTRAS' ? 'extras' : 'normal';
  const url = `/api/live?tab=${encodeURIComponent(currentLiveTab)}&q=${encodeURIComponent(currentLiveSearch)}&group=${liveGroup}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const tabs = data.tabs || [];
    const channels = data.channels || [];

    if (tabContainer && (rebuildTabs || tabContainer.children.length === 0)) {
      tabContainer.innerHTML = tabs.map((t) => `
        <button tabindex="0" data-tab-id="${t.id}" class="live-tab-btn tv-focusable ${currentLiveTab === t.id ? 'active' : ''}" onclick="selectLiveTab('${t.id}')">
          ${t.label}
        </button>
      `).join('');
      const activeBtn = tabContainer.querySelector(`.live-tab-btn[data-tab-id="${currentLiveTab}"]`);
      if (activeBtn && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('live-tab-btn')) {
        activeBtn.focus();
      }
    }

    if (channels.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;padding:40px;color:var(--muted);text-align:center;">No channels found for this category.</div>';
      return;
    }

    liveZapList = channels;
    grid.innerHTML = channels.map((ch) => {
      return `
        <div class="live-channel-card">
          <div class="channel-left">
            ${renderChannelBadge(ch)}
            <div class="channel-info">
              <div class="channel-name" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
                <span class="badge-genre" style="font-size:10px;padding:1px 6px;">${escapeHtml((ch.categoryName || 'General').replace(/^[\.\s…\-–—\|]+$/, '') || 'General')}</span>
                <span class="badge-quality" style="font-size:9px;padding:1px 4px;">LIVE</span>
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button tabindex="0" class="btn btn-primary tv-focusable" style="padding:7px 14px;font-size:12px;" onclick="startLivePlayback('${ch.streamId}', '${escapeHtml(ch.name)}')">
              Watch
            </button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;color:#EF4444;">Error loading channels: ${escapeHtml(err.message)}</div>`;
  }
}

function renderChannelBadge(ch) {
  const cat = (ch.categoryName || '').toUpperCase();
  let grad = 'linear-gradient(135deg, var(--theme-deep) 0%, var(--theme-darkest) 100%)';
  if (/SPORTS|CRICKET|FOOTBALL|SOCCER|GOLF|WWE|UFC|F1|RACING|TENNIS|NBA|ESPN|SKY SPORT/.test(cat)) {
    grad = 'linear-gradient(135deg, #DC2626 0%, #991B1B 100%)';
  } else if (/NEWS|CNN|BBC|SKY NEWS|AL JAZEERA|GEO|ARY|BOL|HUM|AAJ/.test(cat)) {
    grad = 'linear-gradient(135deg, #1D4ED8 0%, #1E3A8A 100%)';
  } else if (/CINEMA|MOVIE|FILM|HBO|BOX OFFICE|STAR MOVIES/.test(cat)) {
    grad = 'linear-gradient(135deg, #D97706 0%, #78350F 100%)';
  } else if (/KIDS|CARTOON|DISNEY|NICK|POGO|ANIME/.test(cat)) {
    grad = 'linear-gradient(135deg, #059669 0%, #064E3B 100%)';
  }

  let clean = String(ch.name || '')
    .replace(/^[|:•●★\s-]+/g, '')
    .replace(/^([A-Za-z]{2,4})\s*[:|]\s*/i, '')
    .replace(/\|[A-Za-z]{2,4}\|/gi, '')
    .replace(/\b(FHD|HD|UHD|4K|1080p|720p|HEVC)\b/gi, '')
    .trim();
  const words = clean.split(/\s+/).filter(Boolean);
  let monogram = 'TV';
  if (words.length > 0) {
    if (words[0].length >= 3 && words[0].length <= 5) monogram = words[0].toUpperCase();
    else monogram = words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
  if (!monogram) monogram = 'TV';

  return `
    <div style="position:relative;width:46px;height:46px;flex-shrink:0;">
      <div style="width:46px;height:46px;border-radius:10px;background:${grad};box-shadow:0 4px 12px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;letter-spacing:0.5px;color:#FFFFFF;border:1px solid rgba(255,255,255,0.18);">
        ${monogram}
      </div>
    </div>
  `;
}

// 4. WATCHLIST
async function loadWatchlist(vp) {
  try {
    const res = await fetch('/api/watchlist');
    const data = await res.json();
    const items = data.items || [];
    vp.innerHTML = `
      <div style="padding:34px 44px;">
        <div style="font-size:24px;font-weight:900;margin-bottom:18px;">My List (${items.length})</div>
        ${items.length === 0
          ? '<div style="color:var(--muted);font-size:15px;margin-top:20px;">Your watchlist is empty. Open a title and choose "+ Add to List".<br/><button tabindex="0" id="btnBrowseFromEmptyList" class="btn btn-primary tv-focusable" style="margin-top:14px;padding:8px 18px;font-size:13px;" onclick="navigateToTab(\'MOVIES\')" onfocus="playNavSound()">Browse movies</button></div>'
          : `<div class="results-grid">${items.map((m) => renderPosterCard(m)).join('')}</div>`}
      </div>
    `;
  } catch (err) {
    vp.innerHTML = `<div style="padding:40px;color:#EF4444;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// 4.5. USER PROFILES & PERSONAL PREFERENCES (Isolated from Account & IPTV credentials)
let currentActiveProfile = getDefaultProfile();
window.currentActiveProfile = currentActiveProfile;

// Theme: clicking a colour only PREVIEWS it. It is kept when Save Profile is pressed; if the screen is left without saving,
// the saved theme comes back.
let themePreviewActive = false;

function applyThemeClass(themeKey) {
  document.body.classList.remove('theme-netflix', 'theme-disney', 'theme-prime');
  if (themeKey && themeKey !== 'purple' && themeKey !== 'streamvault') {
    document.body.classList.add('theme-' + themeKey);
  }
}

// Commit: used when a theme is loaded or saved
function applyProfileTheme(themeKey) {
  applyThemeClass(themeKey);
  themePreviewActive = false;
  localStorage.setItem('streamvault_active_theme', themeKey || 'purple');
}

function savedThemeKey() {
  return localStorage.getItem('streamvault_active_theme') || 'purple';
}

function revertThemePreview() {
  if (!themePreviewActive) return;
  const saved = savedThemeKey();
  applyThemeClass(saved);
  if (currentActiveProfile) currentActiveProfile.theme = saved;
  themePreviewActive = false;
}

function setProfileTheme(themeKey) {
  playNavSound();
  currentActiveProfile.theme = themeKey;
  applyThemeClass(themeKey);                       // preview only: nothing is stored until Save
  themePreviewActive = themeKey !== savedThemeKey();
  document.querySelectorAll('.profile-theme-chip').forEach(c => {
    if (c.getAttribute('data-theme') === themeKey) {
      c.style.border = '2.5px solid #FFFFFF';
      c.style.transform = 'scale(1.08)';
    } else {
      c.style.border = '1.5px solid rgba(255,255,255,0.15)';
      c.style.transform = 'scale(1)';
    }
  });
}

async function loadProfile(vp) {
  let profilesData = { profiles: [], activeProfileId: '' };
  try {
    const pRes = await fetch('/api/profiles').catch(() => null);
    if (pRes) profilesData = await pRes.json();
  } catch (_) {}

  const savedTheme = localStorage.getItem('streamvault_active_theme') || 'purple';
  const primaryName = getAccountDisplayName();
  const profiles = (profilesData && profilesData.profiles && profilesData.profiles.length)
    ? profilesData.profiles
    : [
        { id: 'prof_primary', name: primaryName, avatarColor: '#7C3AED', isKids: false, isActive: true, isPrimary: true, theme: savedTheme }
      ];
  const activeProf = profiles.find(p => p.id === profilesData.activeProfileId) || profiles[0];
  if (!activeProf.theme) activeProf.theme = savedTheme;
  currentActiveProfile = { ...activeProf };
  applyProfileTheme(currentActiveProfile.theme);

  vp.innerHTML = `
    <div style="padding:8px 24px 22px 24px;max-width:1440px;margin:0 auto;box-sizing:border-box;max-height:100vh;overflow:hidden;">
      <div style="font-size:18px;font-weight:900;letter-spacing:-0.4px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">
        <span>Profile &amp; Personal Settings</span>
        <span style="font-size:11px;color:var(--theme-border);font-weight:700;display:flex;align-items:center;gap:6px;">
          <span style="width:7px;height:7px;border-radius:50%;background:#10B981;display:inline-block;"></span>
          ${escapeHtml(activeProf.name)} &middot; StreamVault TV
        </span>
      </div>

      <!-- Who's Watching? Switcher Row -->
      <div style="margin-bottom:8px;">
        <div style="font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Select Profile (${profiles.length}/5)</div>
        <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:10px;">
          ${profiles.map(p => `
            <div tabindex="0" class="profile-card-item tv-focusable ${p.id === activeProf.id ? 'is-active-profile' : ''}"
                 onclick="switchUserProfile('${p.id}')" onfocus="playNavSound()"
                 style="background:var(--panel);border:${p.id === activeProf.id ? '2px solid var(--theme-accent)' : '1.5px solid var(--card-border)'};border-radius:10px;padding:6px 10px;display:flex;align-items:center;gap:10px;cursor:pointer;box-sizing:border-box;min-height:42px;box-shadow:${p.id === activeProf.id ? '0 0 14px var(--theme-glow)' : 'none'};">
              <div class="profile-avatar-initials" style="width:28px;height:28px;border-radius:50%;background:${escapeHtml(p.avatarColor || 'var(--theme-accent)')};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:900;flex-shrink:0;">
                ${escapeHtml((p.name || 'U').slice(0, 2).toUpperCase())}
              </div>
              <div style="min-width:0;flex:1;">
                <div class="profile-name-text" style="font-size:12px;font-weight:800;color:#FFFFFF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.name)}</div>
                <div style="font-size:9px;color:${p.id === activeProf.id ? 'var(--theme-border)' : '#9CA3AF'};font-weight:700;margin-top:1px;">
                  ${p.id === activeProf.id ? '✓ Active Profile' : (p.isKids ? 'Kids Mode' : 'Switch')}
                </div>
              </div>
            </div>
          `).join('')}

          ${profiles.length < 5 ? `
          <div tabindex="0" class="profile-card-item tv-focusable" onclick="promptAddNewProfile()" onfocus="playNavSound()"
               style="background:rgba(255,255,255,0.03);border:1.5px dashed #374151;border-radius:10px;padding:6px 10px;display:flex;align-items:center;gap:10px;cursor:pointer;box-sizing:border-box;min-height:42px;">
            <div style="width:28px;height:28px;border-radius:50%;background:#1F2937;display:flex;align-items:center;justify-content:center;color:#9CA3AF;font-size:16px;font-weight:800;flex-shrink:0;">+</div>
            <div style="font-size:12px;font-weight:700;color:#9CA3AF;">Add Profile</div>
          </div>
          ` : ''}
        </div>
      </div>

      <!-- Symmetrical 50/50 Dual-Card Profile Customization & Parental Controls -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch;">
        <!-- Left: Active Profile Settings & Theme Selector -->
        <div class="settings-card" style="background:var(--panel);border:1.5px solid var(--card-border);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;">
          <div>
            <div style="font-size:13px;font-weight:800;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--theme-border)" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Profile Customization
            </div>

            <div style="margin-bottom:8px;">
              <label style="display:block;font-size:9.5px;font-weight:700;color:#9CA3AF;margin-bottom:2px;">Display Name</label>
              <input id="profNameInput" class="search-field tv-focusable"
                     readonly onclick="this.removeAttribute('readonly');this.focus();" onblur="this.setAttribute('readonly','true');"
                     onkeydown="onInputKeyDown(this, event)"
                     style="width:100%;font-size:11px;padding:5px 8px;" value="${escapeHtml(activeProf.name)}" />
            </div>

            <div style="margin-bottom:8px;">
              <label style="display:block;font-size:9.5px;font-weight:700;color:#9CA3AF;margin-bottom:4px;">Streaming Theme Palette</label>
              <div style="display:flex;gap:8px;" id="profileThemeGroup">
                <div tabindex="0" class="profile-theme-chip tv-focusable" onclick="setProfileTheme('purple')" onfocus="playNavSound()" data-theme="purple"
                     style="padding:4px 8px;border-radius:6px;background:rgba(139,92,246,0.2);cursor:pointer;border:${(!activeProf.theme || activeProf.theme === 'purple') ? '2px solid #A78BFA' : '1.5px solid rgba(255,255,255,0.15)'};color:#DDD6FE;font-size:10px;font-weight:800;display:flex;align-items:center;gap:5px;">
                  <span style="width:8px;height:8px;border-radius:50%;background:#8B5CF6;"></span> Purple
                </div>
                <div tabindex="0" class="profile-theme-chip tv-focusable" onclick="setProfileTheme('netflix')" onfocus="playNavSound()" data-theme="netflix"
                     style="padding:4px 8px;border-radius:6px;background:rgba(229,9,20,0.2);cursor:pointer;border:${activeProf.theme === 'netflix' ? '2px solid #EF4444' : '1.5px solid rgba(255,255,255,0.15)'};color:#FCA5A5;font-size:10px;font-weight:800;display:flex;align-items:center;gap:5px;">
                  <span style="width:8px;height:8px;border-radius:50%;background:#E50914;"></span> Red
                </div>
                <div tabindex="0" class="profile-theme-chip tv-focusable" onclick="setProfileTheme('disney')" onfocus="playNavSound()" data-theme="disney"
                     style="padding:4px 8px;border-radius:6px;background:rgba(0,99,229,0.2);cursor:pointer;border:${activeProf.theme === 'disney' ? '2px solid #60A5FA' : '1.5px solid rgba(255,255,255,0.15)'};color:#BFDBFE;font-size:10px;font-weight:800;display:flex;align-items:center;gap:5px;">
                  <span style="width:8px;height:8px;border-radius:50%;background:#0063E5;"></span> Blue
                </div>
                <div tabindex="0" class="profile-theme-chip tv-focusable" onclick="setProfileTheme('prime')" onfocus="playNavSound()" data-theme="prime"
                     style="padding:4px 8px;border-radius:6px;background:rgba(0,168,225,0.2);cursor:pointer;border:${activeProf.theme === 'prime' ? '2px solid #38BDF8' : '1.5px solid rgba(255,255,255,0.15)'};color:#BAE6FD;font-size:10px;font-weight:800;display:flex;align-items:center;gap:5px;">
                  <span style="width:8px;height:8px;border-radius:50%;background:#00A8E1;"></span> Cyan
                </div>
              </div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);">
              <div>
                <div style="font-size:11px;font-weight:700;color:#F3F4F6;">Kids Mode Restriction</div>
                <div style="font-size:9px;color:#9CA3AF;margin-top:1px;">Family-friendly titles only.</div>
              </div>
              <button tabindex="0" id="btnToggleKidsMode" class="btn tv-focusable" style="padding:3px 10px;font-size:10px;${activeProf.isKids ? 'background:#059669;border-color:#10B981;color:#fff;' : 'background:#262A38;border-color:#374151;color:#9CA3AF;'}" onclick="toggleProfileKidsMode()">${activeProf.isKids ? 'Enabled' : 'Disabled'}</button>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);">
            <span id="profSaveStatus" style="font-size:10px;font-weight:700;color:#10B981;"></span>
            <div style="display:flex;gap:6px;">
              ${!activeProf.isPrimary ? `<button tabindex="0" id="btnDeleteProfile" class="btn tv-focusable" style="border-color:#EF4444;color:#F87171;padding:3px 10px;font-size:10.5px;" onclick="promptDeleteCurrentProfile()">Delete</button>` : ''}
              <button tabindex="0" id="btnSaveProfile" class="btn btn-primary tv-focusable" style="padding:4px 14px;font-size:11px;" onclick="saveActiveProfileChanges()">Save Profile</button>
            </div>
          </div>
        </div>

        <!-- Right: Parental Controls, Master PIN & History Privacy -->
        <div class="settings-card" style="background:var(--panel);border:1.5px solid var(--card-border);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;">
          <div>
            <div style="font-size:13px;font-weight:800;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              Parental Controls &amp; PIN
            </div>

            <div style="display:flex;gap:6px;align-items:flex-end;margin-bottom:6px;">
              <div style="flex:1;">
                <label style="display:block;font-size:9px;font-weight:700;color:#9CA3AF;margin-bottom:1px;">Current</label>
                <input id="setCurPin" type="password" maxlength="4" class="search-field tv-focusable"
                       readonly onclick="this.removeAttribute('readonly');this.focus();" onblur="this.setAttribute('readonly','true');"
                       oninput="onPinInput(this)" onkeydown="onInputKeyDown(this, event)"
                       style="width:100%;font-size:12px;letter-spacing:2.5px;text-align:center;padding:4px 2px;" placeholder="••••" />
              </div>
              <div style="flex:1;">
                <label style="display:block;font-size:9px;font-weight:700;color:#9CA3AF;margin-bottom:1px;">New</label>
                <input id="setNewPin" type="password" maxlength="4" class="search-field tv-focusable"
                       readonly onclick="this.removeAttribute('readonly');this.focus();" onblur="this.setAttribute('readonly','true');"
                       oninput="onPinInput(this)" onkeydown="onInputKeyDown(this, event)"
                       style="width:100%;font-size:12px;letter-spacing:2.5px;text-align:center;padding:4px 2px;" placeholder="••••" />
              </div>
              <div style="flex:1;">
                <label style="display:block;font-size:9px;font-weight:700;color:#9CA3AF;margin-bottom:1px;">Confirm</label>
                <input id="setConfirmPin" type="password" maxlength="4" class="search-field tv-focusable"
                       readonly onclick="this.removeAttribute('readonly');this.focus();" onblur="this.setAttribute('readonly','true');"
                       oninput="onPinInput(this)" onkeydown="onInputKeyDown(this, event)"
                       style="width:100%;font-size:12px;letter-spacing:2.5px;text-align:center;padding:4px 2px;" placeholder="••••" />
              </div>
              <div>
                <button tabindex="0" id="btnUpdatePin" class="btn tv-focusable" style="padding:4px 10px;font-size:10.5px;" onclick="changeParentalPin()">Update</button>
              </div>
            </div>

            ${(currentActiveProfile && currentActiveProfile.isKids) ? `
            <div style="padding:6px 0;border-top:1px solid rgba(255,255,255,0.06);font-size:10px;color:#9CA3AF;">Kids Mode is on: 18+ and Extras are not available.</div>` : `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid rgba(255,255,255,0.06);">
              <div>
                <div style="font-size:11px;font-weight:700;color:#F3F4F6;">18+ Adult</div>
                <div style="font-size:9px;color:#9CA3AF;margin-top:1px;">Needs Master PIN. Re-locks by itself.</div>
              </div>
              <button tabindex="0" id="btnToggleParentalLock" class="btn tv-focusable" style="padding:3px 12px;font-size:10.5px;" onclick="toggleParentalLockSession()">Unlock</button>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid rgba(255,255,255,0.06);">
              <div>
                <div style="font-size:11px;font-weight:700;color:#F3F4F6;">Extras</div>
                <div style="font-size:9px;color:#9CA3AF;margin-top:1px;">Naats, dance, clips, WWE. Same rules.</div>
              </div>
              <button tabindex="0" id="btnToggleExtrasLock" class="btn tv-focusable" style="padding:3px 12px;font-size:10.5px;" onclick="toggleExtrasLockSession()">Unlock</button>
            </div>`}

            <div style="display:flex;justify-content:space-between;align-items:center;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);">
              <div>
                <div style="font-size:11px;font-weight:700;color:#F3F4F6;">Clear Search History</div>
                <div style="font-size:9px;color:#9CA3AF;margin-top:1px;">Watched list stays safe.</div>
              </div>
              <button tabindex="0" id="btnClearHistory" class="btn tv-focusable" style="padding:3px 12px;font-size:10.5px;" onclick="openClearAllHistoryModal()">Clear</button>
            </div>
          </div>

          <div id="pinChangeStatus" style="font-size:9.5px;font-weight:700;height:12px;margin-top:2px;"></div>
        </div>
      </div>
    </div>
  `;

  updateParentalStatusInSettings();
  setTimeout(() => {
    const firstField = document.getElementById('profNameInput');
    if (firstField) { firstField.focus(); playNavSound(); }
  }, 40);
}

// 5. COMPREHENSIVE SETTINGS (Account, IPTV Playlists, Hardware & System)
// The screen is drawn at once from what the TV already knows; the cloud list is fetched in the background and the
// screen is redrawn only if it differs (the focus stays on the same button).
const playlistSig = (list) => (list || []).map((p) => { const l = playlistLiveStatus(p); return [p.playlist_id, p.name, p.username, p.server_url, p.status, l.status, l.error].join('|'); }).join(';');
async function loadSettings(vp, skipFetch = false) {
  const localAccount = JSON.parse(localStorage.getItem('streamvault_account') || '{}');
  const isLinked = Boolean(localAccount && localAccount.email);
  const accountEmail = localAccount.email || 'Guest Mode (Local Only)';

  const playlists = cachedPlaylists.slice();
  if (!skipFetch) {
    const shownSig = playlistSig(playlists);
    loadPlaylistsData().then((fresh) => {
      if (currentTab !== 'SETTINGS' || vp !== document.getElementById('mainViewport')) return;
      if (playlistSig(fresh) === shownSig) return;
      const focusedId = document.activeElement && document.activeElement.id;
      loadSettings(vp, true);
      if (focusedId) setTimeout(() => { const el = document.getElementById(focusedId); if (el) el.focus(); }, 30);
    }).catch(() => {});
  }

  vp.innerHTML = `
    <div style="padding:8px 24px 22px 24px;max-width:1440px;margin:0 auto;box-sizing:border-box;max-height:100vh;overflow:hidden;">
      <div style="font-size:18px;font-weight:900;letter-spacing:-0.4px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">
        <span>Settings</span>
        <span style="font-size:11px;color:var(--theme-border);font-weight:700;display:flex;align-items:center;gap:6px;">
          <span style="width:7px;height:7px;border-radius:50%;background:#10B981;display:inline-block;"></span>
          StreamVault TV v2.7.0
        </span>
      </div>

      ${appStatus && appStatus.lastCrash ? `
        <div style="background:rgba(239,68,68,0.10);border:1px solid #7F1D2D;border-radius:8px;padding:5px 10px;margin-bottom:6px;font-size:9.5px;color:#FCA5A5;display:flex;align-items:center;gap:10px;">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">The app closed unexpectedly last time: ${escapeHtml(String(appStatus.lastCrash))}</span>
          <button tabindex="0" id="btnDismissCrash" class="btn tv-focusable" style="padding:1px 8px;font-size:9.5px;flex-shrink:0;" onclick="dismissCrashNote()">OK</button>
        </div>
      ` : ''}
      <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:10px;box-sizing:border-box;">
        <!-- Quadrant 1 (Top-Left): IPTV Playlists Manager -->
        <div class="settings-card" style="background:var(--panel);border:1.5px solid var(--card-border);border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;min-height:220px;">
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <div style="font-size:13px;font-weight:800;display:flex;align-items:center;gap:8px;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" stroke-width="2"><rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></svg>
                IPTV Playlists (${playlists.length})
              </div>
              <button tabindex="0" id="btnAddPlaylistBtn" class="btn btn-primary tv-focusable" style="padding:3px 10px;font-size:10.5px;font-weight:800;" onclick="openAddPlaylistModal()">+ Add Playlist</button>
            </div>

            <!-- Playlists List / First-Run Guidance -->
            ${playlists.length === 0 ? `
              <div style="background:rgba(var(--theme-deep-rgb),0.08);border:1.5px dashed var(--theme-deep);border-radius:10px;padding:16px 14px;text-align:center;margin-top:4px;">
                <div style="font-size:13px;font-weight:800;color:#FFFFFF;margin-bottom:3px;">No Playlists Connected</div>
                <div style="font-size:10px;color:#9CA3AF;line-height:1.4;margin-bottom:10px;">
                  Add your IPTV provider login to load movies, series and live TV.
                </div>
                <button tabindex="0" id="btnFirstRunAddPlaylist" class="btn btn-primary tv-focusable" style="padding:6px 16px;font-size:11px;font-weight:800;" onclick="openAddPlaylistModal()">+ Connect Your First Playlist</button>
              </div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:6px;max-height:145px;overflow-y:auto;">
                ${playlists.map((pl, idx) => {
                  const live = playlistLiveStatus(pl);
                  const badge = playlistBadge(live);
                  const statusClass = badge.cls;
                  const statusText = badge.text;
                  return `
                    <div style="background:#0F0B20;border:1px solid #231B3D;border-radius:8px;padding:6px 10px;display:flex;align-items:center;justify-content:space-between;">
                      <div style="min-width:0;flex:1;">
                        <div style="display:flex;align-items:center;gap:6px;">
                          <span style="font-size:11.5px;font-weight:800;color:#FFFFFF;">${escapeHtml(pl.name || 'IPTV ' + (idx + 1))}</span>
                          <span class="${statusClass}" data-pl-badge="${escapeHtml(pl.playlist_id)}">${statusText}</span>
                        </div>
                        <div style="font-size:9.5px;color:#9CA3AF;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                          ${escapeHtml(pl.server_url || pl.serverUrl || '')} &middot; User: ${escapeHtml(pl.username || '')}
                        </div>
                        <div data-pl-reason="${escapeHtml(pl.playlist_id)}" style="display:${live.error ? 'block' : 'none'};font-size:9.5px;color:#FCA5A5;margin-top:2px;">${escapeHtml(live.error)}</div>
                      </div>
                      <div style="display:flex;gap:5px;align-items:center;">
                        <button tabindex="0" class="btn tv-focusable" style="padding:2px 7px;font-size:9.5px;" onclick="openEditPlaylistModal('${pl.playlist_id}')">Edit</button>
                        <button tabindex="0" class="btn tv-focusable" style="padding:2px 7px;font-size:9.5px;color:#F87171;" onclick="deletePlaylist('${pl.playlist_id}')">✕</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </div>

        </div>

        <!-- Quadrant 2 (Top-Right): Cloud Account & Bedside Phone Link -->
        <div class="settings-card" style="background:var(--panel);border:1.5px solid var(--card-border);border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;min-height:220px;">
          <div>
            <div style="font-size:13px;font-weight:800;margin-bottom:6px;display:flex;align-items:center;gap:8px;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
              Account
            </div>

            ${isLinked ? `
              <div style="background:rgba(16,185,129,0.08);border:1.5px solid #059669;border-radius:10px;padding:10px 12px;margin-bottom:6px;">
                <div style="font-size:9.5px;font-weight:800;color:#34D399;text-transform:uppercase;letter-spacing:0.6px;">Signed in</div>
                <div style="font-size:13px;font-weight:900;color:#FFFFFF;margin-top:2px;">${escapeHtml(accountEmail)}</div>
                <div style="font-size:9.5px;color:#9CA3AF;margin-top:3px;">Synced across your TVs.</div>
              </div>
            ` : `
              <div style="background:#0A0814;border:1px solid #1E1736;border-radius:10px;padding:10px 12px;margin-bottom:6px;font-size:11px;color:#D1D5DB;">Not signed in. Sign in to sync your TVs.</div>
            `}
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);">
            ${isLinked ? `
              <button tabindex="0" id="btnSignOutAccount" class="btn tv-focusable" style="border-color:#EF4444;color:#F87171;padding:3px 10px;font-size:10px;" onclick="openSignOutModal()">Sign Out</button>
            ` : `
              <button tabindex="0" id="btnOpenCloudSignIn" class="btn tv-focusable" style="background:var(--theme-accent);border-color:var(--theme-border);color:#fff;padding:3px 10px;font-size:10px;font-weight:800;" onclick="openCloudAuthModal('login')">Sign In / Sign Up</button>
            `}
            <div style="display:flex;gap:6px;align-items:center;">
              <span id="syncStatusLabel" style="font-size:9.5px;color:#9CA3AF;font-weight:700;">Just now</span>
              <span id="syncPendingLabel" style="font-size:9px;color:#10B981;font-weight:800;background:rgba(16,185,129,0.12);padding:2px 6px;border-radius:4px;">All synced</span>
              <button tabindex="0" id="btnSyncNow" class="btn btn-primary tv-focusable" style="padding:3px 12px;font-size:10px;background:#059669;border-color:#10B981;" onclick="triggerCloudSync()">Sync Cloud</button>
            </div>
          </div>
        </div>

        <!-- Quadrant 3 (Bottom-Left): Playback & Hardware Engine -->
        <div class="settings-card" style="background:var(--panel);border:1.5px solid var(--card-border);border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;">
          <div>
            <div style="font-size:13px;font-weight:800;margin-bottom:6px;display:flex;align-items:center;gap:8px;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
              Playback
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#D1D5DB;margin-bottom:4px;">
              <span>Video decoding</span>
              <span style="color:#10B981;font-weight:800;background:rgba(16,185,129,0.1);padding:1px 6px;border-radius:4px;border:1px solid rgba(16,185,129,0.3);font-size:10px;">Hardware</span>
            </div>
          </div>

        </div>

        <!-- Quadrant 4 (Bottom-Right): Maintenance & Factory Reset -->
        <div class="settings-card" style="background:var(--panel);border:1.5px solid var(--card-border);border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;">
          <div>
            <div style="font-size:13px;font-weight:800;margin-bottom:6px;display:flex;align-items:center;gap:8px;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              System Maintenance
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <div>
                <div style="font-size:11px;font-weight:700;color:#F3F4F6;">Details &amp; ratings</div>
                <div style="font-size:9px;color:#9CA3AF;margin-top:1px;">Loaded once.</div>
              </div>
              <span id="settingsEnrichStatus" style="font-size:10px;font-weight:800;text-align:right;max-width:55%;">…</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <div>
                <div style="font-size:11px;font-weight:700;color:#F3F4F6;">Catalog</div>
                <div style="font-size:9px;color:#9CA3AF;margin-top:1px;">Checked daily.</div>
              </div>
              <button tabindex="0" id="btnEnrichNow" class="btn tv-focusable" style="padding:2px 8px;font-size:10px;" onclick="triggerFullEnrichmentSync()">Check for new titles</button>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <div>
                <div style="font-size:11px;font-weight:700;color:#F3F4F6;">Something wrong?</div>
                <div style="font-size:9px;color:#9CA3AF;margin-top:1px;">Recent app activity.</div>
              </div>
              <button tabindex="0" id="btnReportProblem" class="btn tv-focusable" style="padding:2px 8px;font-size:10px;" onclick="openDiagModal()">Report a problem</button>
            </div>

          </div>

        </div>
      </div>

      <!-- About & Credits: TMDB attribution (required by the TMDB API terms of use).
           The card itself is focusable so the TV remote (D-pad) can reach and scroll to it. -->
      <div id="settingsAboutCard" tabindex="0" class="settings-card tv-focusable" onfocus="playNavSound()"
           style="background:var(--panel);border:1.5px solid var(--card-border);border-radius:12px;padding:10px 14px;box-sizing:border-box;display:flex;align-items:center;gap:14px;">
        <div id="tmdbLogoSlot" style="flex-shrink:0;display:flex;align-items:center;justify-content:center;min-width:84px;">
          <svg role="img" aria-label="TMDB" style="width:84px;height:auto;display:block;" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 273.42 35.52"><defs><style>.cls-1{fill:url(#linear-gradient);}</style><linearGradient id="linear-gradient" y1="17.76" x2="273.42" y2="17.76" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#90cea1"/><stop offset="0.56" stop-color="#3cbec9"/><stop offset="1" stop-color="#00b3e5"/></linearGradient></defs><g id="Layer_2" data-name="Layer 2"><g id="Layer_1-2" data-name="Layer 1"><path class="cls-1" d="M191.85,35.37h63.9A17.67,17.67,0,0,0,273.42,17.7h0A17.67,17.67,0,0,0,255.75,0h-63.9A17.67,17.67,0,0,0,174.18,17.7h0A17.67,17.67,0,0,0,191.85,35.37ZM10.1,35.42h7.8V6.92H28V0H0v6.9H10.1Zm28.1,0H46V8.25h.1L55.05,35.4h6L70.3,8.25h.1V35.4h7.8V0H66.45l-8.2,23.1h-.1L50,0H38.2ZM89.14.12h11.7a33.56,33.56,0,0,1,8.08,1,18.52,18.52,0,0,1,6.67,3.08,15.09,15.09,0,0,1,4.53,5.52,18.5,18.5,0,0,1,1.67,8.25,16.91,16.91,0,0,1-1.62,7.58,16.3,16.3,0,0,1-4.38,5.5,19.24,19.24,0,0,1-6.35,3.37,24.53,24.53,0,0,1-7.55,1.15H89.14Zm7.8,28.2h4a21.66,21.66,0,0,0,5-.55A10.58,10.58,0,0,0,110,26a8.73,8.73,0,0,0,2.68-3.35,11.9,11.9,0,0,0,1-5.08,9.87,9.87,0,0,0-1-4.52,9.17,9.17,0,0,0-2.63-3.18A11.61,11.61,0,0,0,106.22,8a17.06,17.06,0,0,0-4.68-.63h-4.6ZM133.09.12h13.2a32.87,32.87,0,0,1,4.63.33,12.66,12.66,0,0,1,4.17,1.3,7.94,7.94,0,0,1,3,2.72,8.34,8.34,0,0,1,1.15,4.65,7.48,7.48,0,0,1-1.67,5,9.13,9.13,0,0,1-4.43,2.82V17a10.28,10.28,0,0,1,3.18,1,8.51,8.51,0,0,1,2.45,1.85,7.79,7.79,0,0,1,1.57,2.62,9.16,9.16,0,0,1,.55,3.2,8.52,8.52,0,0,1-1.2,4.68,9.32,9.32,0,0,1-3.1,3A13.38,13.38,0,0,1,152.32,35a22.5,22.5,0,0,1-4.73.5h-14.5Zm7.8,14.15h5.65a7.65,7.65,0,0,0,1.78-.2,4.78,4.78,0,0,0,1.57-.65,3.43,3.43,0,0,0,1.13-1.2,3.63,3.63,0,0,0,.42-1.8A3.3,3.3,0,0,0,151,8.6a3.42,3.42,0,0,0-1.23-1.13A6.07,6.07,0,0,0,148,6.9a9.9,9.9,0,0,0-1.85-.18h-5.3Zm0,14.65h7a8.27,8.27,0,0,0,1.83-.2,4.67,4.67,0,0,0,1.67-.7,3.93,3.93,0,0,0,1.23-1.3,3.8,3.8,0,0,0,.47-1.95,3.16,3.16,0,0,0-.62-2,4,4,0,0,0-1.58-1.18,8.23,8.23,0,0,0-2-.55,15.12,15.12,0,0,0-2.05-.15h-5.9Z"/></g></g></svg>
        </div>
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:800;margin-bottom:2px;">About &amp; Credits</div>
          <div id="tmdbAttributionText" style="font-size:10.5px;color:#D1D5DB;line-height:1.4;">This product uses the TMDB API but is not endorsed or certified by TMDB.</div>
        </div>
      </div>
    </div>
  `;

  renderSyncStatus();
  watchPlaylistStatus();
  setTimeout(() => {
    const firstBtn = document.getElementById('btnFirstRunAddPlaylist') || document.getElementById('btnAddPlaylistBtn') || document.getElementById('btnSyncNow');
    if (firstBtn) { firstBtn.focus(); playNavSound(); }
  }, 40);
}

// Playlist Management APIs for standalone TV and cloud sync
let cachedPlaylists = [];

// Cloud and TV describe a playlist with different field names; the screen only ever sees this one shape.
function normalizePlaylist(p) {
  const enabled = true;   // there is no On/Off any more: a playlist that is listed is the one in use
  return {
    playlist_id: p.playlist_id || p.playlistId || '',
    name: p.name || '',
    server_url: p.server_url || p.serverUrl || '',
    serverUrl: p.server_url || p.serverUrl || '',
    username: p.username || '',
    password: p.password || '',
    isEnabled: enabled,
    is_enabled: enabled ? 1 : 0,
    status: p.status || ''
  };
}

// What the TV itself is doing with the playlist it is using: syncing, failed (with the reason), loaded, or not loaded yet
function playlistLiveStatus(pl) {
  const creds = (appStatus && appStatus.credentials) || {};
  const sync = (appStatus && appStatus.syncStatus) || {};
  const norm = u => String(u || '').trim().toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '');
  const isOnThisTv = creds.serverUrl && norm(creds.serverUrl) === norm(pl.server_url) && creds.username === pl.username;
  if (!pl.isEnabled) return { status: 'disabled', error: '' };
  if (!isOnThisTv) return { status: pl.status === 'working' || pl.status === 'syncing' || pl.status === 'failed' ? pl.status : 'waiting', error: '' };
  if (sync.isSyncing) return { status: 'syncing', error: '', phase: sync.phase || '' };
  if (sync.error) return { status: 'failed', error: String(sync.error) };
  if ((appStatus.totalCatalogCount || 0) > 0) return { status: 'working', error: '' };
  return { status: 'waiting', error: '' };
}

function playlistBadge(live) {
  if (live.status === 'working') return { cls: 'badge-status-working', text: '✓ Working' };
  if (live.status === 'syncing') return { cls: 'badge-status-syncing', text: '⟳ Loading catalog…' };
  if (live.status === 'failed') return { cls: 'badge-status-failed', text: '⚠ Failed' };
  if (live.status === 'disabled') return { cls: 'badge-status-syncing', text: 'Off' };
  return { cls: 'badge-status-syncing', text: 'Not loaded yet' };
}

// Gives this TV the login of a playlist (the TV downloads the titles itself)
async function sendPlaylistToTv(pl) {
  const res = await fetch('/api/save-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlistName: pl.name || 'Primary IPTV', serverUrl: pl.serverUrl || pl.server_url, username: pl.username, password: pl.password || '' })
  });
  return res.ok;
}

async function refreshAppStatus() {
  try {
    const r = await fetch('/api/state');
    if (r && r.ok) appStatus = await r.json();
  } catch (_) {}
}

// Light refresh: only the sync/enrichment numbers (the full /api/state also runs the home-row queries)
async function refreshSyncStatusOnly() {
  try {
    const r = await fetch('/api/sync/status');
    if (r && r.ok) { const j = await r.json(); if (j && j.syncStatus) appStatus = Object.assign({}, appStatus || {}, { syncStatus: j.syncStatus }); }
  } catch (_) {}
}

async function loadPlaylistsData() {
  try {
    await refreshAppStatus();
    const res = await fetch('/api/playlists');
    const data = await res.json();
    cachedPlaylists = (data.playlists || []).map(normalizePlaylist);
    if (!hasActivePlaylist()) {
      const pl = cachedPlaylists.find(p => p.isEnabled && p.server_url && p.username && p.password);
      if (pl) {
        try { if (await sendPlaylistToTv(pl)) await refreshAppStatus(); } catch (_) {}
      }
    }
    return cachedPlaylists;
  } catch (err) {
    cachedPlaylists = [];
    return [];
  }
}

// While the catalog downloads, keep the badge on the Settings screen honest (no full redraw, focus stays where it is)
let playlistStatusTimer = null;
function watchPlaylistStatus() {
  if (playlistStatusTimer) clearInterval(playlistStatusTimer);
  playlistStatusTimer = setInterval(async () => {
    if (currentTab !== 'SETTINGS' || !document.querySelector('[data-pl-badge]')) { clearInterval(playlistStatusTimer); playlistStatusTimer = null; return; }
    await refreshAppStatus();
    let anySyncing = false;
    document.querySelectorAll('[data-pl-badge]').forEach(el => {
      const pl = cachedPlaylists.find(p => p.playlist_id === el.getAttribute('data-pl-badge'));
      if (!pl) return;
      const live = playlistLiveStatus(pl);
      const b = playlistBadge(live);
      el.className = b.cls; el.innerText = b.text;
      const why = document.querySelector(`[data-pl-reason="${pl.playlist_id}"]`);
      if (why) { why.innerText = live.error; why.style.display = live.error ? 'block' : 'none'; }
      if (live.status === 'syncing') anySyncing = true;
    });
    if (!anySyncing) { clearInterval(playlistStatusTimer); playlistStatusTimer = null; }
  }, 3000);
}

function openAddPlaylistModal() {
  playNavSound();
  const modal = document.getElementById('playlistModal');
  if (!modal) return;
  const current = cachedPlaylists[0];
  document.getElementById('playlistModalTitle').innerText = current ? 'Replace current playlist?' : 'Add IPTV Playlist';
  const note = document.getElementById('playlistReplaceNote');
  if (note) {
    note.style.display = current ? 'block' : 'none';
    note.innerText = current ? `StreamVault uses one playlist at a time. Saving this one removes "${current.name || 'your current playlist'}" and loads the new one.` : '';
  }
  const saveBtn = document.getElementById('btnSavePlaylist');
  if (saveBtn) saveBtn.innerText = current ? 'Replace & Connect' : 'Save & Connect';
  document.getElementById('playlistModalEditId').value = '';
  document.getElementById('inpPlaylistName').value = 'Primary IPTV';
  document.getElementById('inpPlaylistServer').value = '';
  document.getElementById('inpPlaylistUser').value = '';
  document.getElementById('inpPlaylistPass').value = '';
  const statusMsg = document.getElementById('playlistModalStatusMsg');
  if (statusMsg) statusMsg.innerText = '';
  modal.style.display = 'flex';
  setTimeout(() => {
    document.getElementById('inpPlaylistServer')?.focus();
  }, 100);
}

function openEditPlaylistModal(playlistId) {
  playNavSound();
  const pl = cachedPlaylists.find(p => p.playlist_id === playlistId);
  if (!pl) return;
  const modal = document.getElementById('playlistModal');
  if (!modal) return;
  document.getElementById('playlistModalTitle').innerText = 'Edit IPTV Playlist';
  const note = document.getElementById('playlistReplaceNote'); if (note) note.style.display = 'none';
  const saveBtn = document.getElementById('btnSavePlaylist'); if (saveBtn) saveBtn.innerText = 'Save & Connect';
  document.getElementById('playlistModalEditId').value = playlistId;
  document.getElementById('inpPlaylistName').value = pl.name || 'Primary IPTV';
  document.getElementById('inpPlaylistServer').value = pl.server_url || pl.serverUrl || '';
  document.getElementById('inpPlaylistUser').value = pl.username || '';
  document.getElementById('inpPlaylistPass').value = '';
  const statusMsg = document.getElementById('playlistModalStatusMsg');
  if (statusMsg) statusMsg.innerText = '';
  modal.style.display = 'flex';
  setTimeout(() => {
    document.getElementById('inpPlaylistServer')?.focus();
  }, 100);
}

function closePlaylistModal() {
  playNavSound();
  const modal = document.getElementById('playlistModal');
  if (modal) modal.style.display = 'none';
}

async function handleSavePlaylistSubmit(e) {
  if (e) e.preventDefault();
  const editId = document.getElementById('playlistModalEditId').value;
  const name = document.getElementById('inpPlaylistName').value.trim();
  const serverUrl = document.getElementById('inpPlaylistServer').value.trim();
  const username = document.getElementById('inpPlaylistUser').value.trim();
  const password = document.getElementById('inpPlaylistPass').value;
  const statusMsg = document.getElementById('playlistModalStatusMsg');

  if (!serverUrl || !username) {
    if (statusMsg) {
      statusMsg.style.color = '#EF4444';
      statusMsg.innerText = 'Server URL and username are required';
    }
    return;
  }
  if (!editId && !password) {
    if (statusMsg) {
      statusMsg.style.color = '#EF4444';
      statusMsg.innerText = 'Password is required for new playlist';
    }
    return;
  }

  if (statusMsg) {
    statusMsg.style.color = 'var(--theme-border)';
    statusMsg.innerText = 'Connecting to IPTV provider...';
  }

  try {
    if (!editId && cachedPlaylists.length) {
      // one playlist at a time: the old one goes first (cloud record + this TV's copy)
      for (const old of cachedPlaylists.slice()) {
        await fetch(`/api/playlists/${encodeURIComponent(old.playlist_id)}`, { method: 'DELETE' }).catch(() => {});
      }
      await fetch('/api/clear-playlist', { method: 'POST' }).catch(() => {});
      cachedPlaylists = [];
    }
    const method = editId ? 'PUT' : 'POST';
    const url = editId ? `/api/playlists/${encodeURIComponent(editId)}` : '/api/playlists';
    const payload = { name, serverUrl, username };
    if (password) payload.password = password;

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.success || d.ok) {
      // The cloud keeps the record; this TV needs the login too so it can download the titles
      const existing = editId ? cachedPlaylists.find(p => p.playlist_id === editId) : null;
      const toTv = { name, serverUrl, username, password: password || (existing && existing.password) || '' };
      const wasOnThisTv = !!existing && playlistLiveStatus(existing).status !== 'waiting' && playlistLiveStatus(existing).status !== 'disabled';
      let started = false;
      if (toTv.password && (!existing || existing.isEnabled)) { try { started = await sendPlaylistToTv(toTv); } catch (_) {} }
      closePlaylistModal();
      showToast(started ? '✓ Saved. Loading your catalog now. This can take a few minutes.' : '✓ Playlist saved.');
      await refreshAppStatus();
      const vp = document.getElementById('mainViewport');
      if (vp && currentTab === 'SETTINGS') {
        await loadSettings(vp);
      }
    } else {
      if (statusMsg) {
        statusMsg.style.color = '#EF4444';
        statusMsg.innerText = d.error || 'Failed to save playlist';
      }
    }
  } catch (err) {
    if (statusMsg) {
      statusMsg.style.color = '#EF4444';
      statusMsg.innerText = err.message || 'Connection failed';
    }
  }
}

async function deletePlaylist(playlistId) {
  playNavSound();
  const pl = cachedPlaylists.find(p => p.playlist_id === playlistId);
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, { method: 'DELETE' });
    const d = await res.json();
    if (d.success || d.ok) {
      if (pl) {
        const live = playlistLiveStatus(pl);
        if (live.status !== 'waiting' && live.status !== 'disabled') await fetch('/api/clear-playlist', { method: 'POST' }).catch(() => {});
      }
      showToast('Playlist removed');
      await refreshAppStatus();
      const vp = document.getElementById('mainViewport');
      if (vp && currentTab === 'SETTINGS') await loadSettings(vp);
    } else {
      showToast(d.error || 'Could not remove the playlist');
    }
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

async function dismissCrashNote() {
  playNavSound();
  await fetch('/api/clear-crash', { method: 'POST' }).catch(() => {});
  await refreshAppStatus();
  const vp = document.getElementById('mainViewport');
  if (vp && currentTab === 'SETTINGS') await loadSettings(vp);
}

