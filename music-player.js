(function () {
  const playlist = [
    { file: "Audio Crime - Atomic Amnesia.m4a", name: "Atomic Amnesia" },
    { file: "Marino - I'm Doing Fine (Official AMV).m4a", name: "I'm Doing Fine" }
  ];

  const STATE_KEY = "hellold.music.state.v2";
  const MUTE_COOKIE = "hellold.music.muted";

  function getMuteCookie() {
    const match = document.cookie.split('; ').find(function (c) {
      return c.startsWith(MUTE_COOKIE + '=');
    });
    return match ? match.split('=')[1] : null;
  }

  function setMuteCookie(muted) {
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    document.cookie = MUTE_COOKIE + '=' + (muted ? '1' : '0') +
      '; expires=' + expires.toUTCString() + '; path=/; SameSite=Lax';
  }
  const DEFAULT_STATE = {
    trackIndex: 0,
    currentTime: 0,
    volume: 0.3,
    paused: false,
    loop: false,
    muted: false,
    updatedAt: 0
  };

  const ui = {
    root: document.getElementById("music-player"),
    play: document.getElementById("music-play"),
    seek: document.getElementById("music-seek"),
    download: document.getElementById("music-download"),
    next: document.getElementById("music-next"),
    loop: document.getElementById("music-loop"),
    mute: document.getElementById("music-mute"),
    meta: document.getElementById("music-meta")
  };

  if (!ui.root || playlist.length === 0) {
    return;
  }

  const audio = new Audio();
  audio.preload = "auto";

  let resumePlayQueued = false;
  let seeking = false;

  function readState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch (error) {
      return { ...DEFAULT_STATE };
    }
  }

  let state = readState();

  function clampTrackIndex(index) {
    if (!Number.isFinite(index)) return 0;
    if (index < 0) return 0;
    if (index >= playlist.length) return 0;
    return index;
  }

  state.trackIndex = clampTrackIndex(state.trackIndex);

  function saveState() {
    const data = {
      trackIndex: state.trackIndex,
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : state.currentTime,
      volume: audio.volume,
      paused: audio.paused,
      loop: audio.loop,
      muted: audio.muted,
      updatedAt: Date.now()
    };

    state = data;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(data));
    } catch (error) {
      // Ignore write errors in private mode/storage-restricted contexts.
    }
  }

  function getResumeTime() {
    const safeTime = Number.isFinite(state.currentTime) ? state.currentTime : 0;
    if (state.paused) return safeTime;

    const elapsed = Math.max(0, (Date.now() - (state.updatedAt || 0)) / 1000);
    return safeTime + elapsed;
  }

  function applyMeta() {
    const track = playlist[state.trackIndex];
    ui.meta.textContent = track ? "Now Playing: " + track.name : "Music";
  }

  function updateButtons() {
    ui.play.textContent = audio.paused ? "\u25B6" : "\u275A\u275A";
    ui.mute.textContent = audio.muted || audio.volume === 0 ? "\uD83D\uDD07" : "\uD83D\uDD0A";
    ui.loop.classList.toggle("is-active", audio.loop);
  }

  function updateDownloadLink() {
    const track = playlist[state.trackIndex];
    ui.download.href = track.file;
    ui.download.download = track.file;
  }

  function loadTrack(index, shouldResumePosition) {
    state.trackIndex = clampTrackIndex(index);
    const track = playlist[state.trackIndex];
    audio.src = track.file;
    audio.load();
    applyMeta();
    updateDownloadLink();

    if (shouldResumePosition) {
      const resumeAt = getResumeTime();
      audio.addEventListener(
        "loadedmetadata",
        () => {
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            audio.currentTime = resumeAt % audio.duration;
          }
        },
        { once: true }
      );
    }
  }

  function tryPlay() {
    audio
      .play()
      .then(() => {
        resumePlayQueued = false;
        updateButtons();
        saveState();
      })
      .catch(() => {
        resumePlayQueued = true;
        updateButtons();
      });
  }

  function startFromUserGesture() {
    if (!resumePlayQueued && !audio.paused) return;
    tryPlay();
  }

  audio.volume = Math.max(0, Math.min(1, Number.isFinite(state.volume) ? state.volume : 0.3));
  audio.loop = !!state.loop;
  // Cookie takes priority over localStorage for muted state.
  const muteCookie = getMuteCookie();
  audio.muted = muteCookie !== null ? muteCookie === '1' : !!state.muted;

  loadTrack(state.trackIndex, true);

  if (!state.paused) {
    tryPlay();
  }

  ui.play.addEventListener("click", () => {
    if (audio.paused) {
      tryPlay();
      return;
    }
    audio.pause();
    updateButtons();
    saveState();
  });

  ui.next.addEventListener("click", () => {
    const nextIndex = (state.trackIndex + 1) % playlist.length;
    const wasPaused = audio.paused;
    loadTrack(nextIndex, false);
    audio.currentTime = 0;
    if (!wasPaused) {
      tryPlay();
    } else {
      updateButtons();
      saveState();
    }
  });

  ui.loop.addEventListener("click", () => {
    audio.loop = !audio.loop;
    updateButtons();
    saveState();
  });

  ui.mute.addEventListener("click", () => {
    audio.muted = !audio.muted;    setMuteCookie(audio.muted);    updateButtons();
    saveState();
  });

  ui.seek.addEventListener("input", () => {
    seeking = true;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const nextTime = (Number(ui.seek.value) / 100) * audio.duration;
    audio.currentTime = nextTime;
  });

  ui.seek.addEventListener("change", () => {
    seeking = false;
    saveState();
  });

  audio.addEventListener("timeupdate", () => {
    if (seeking || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    ui.seek.value = String((audio.currentTime / audio.duration) * 100);
    saveState();
  });

  audio.addEventListener("volumechange", () => {
    updateButtons();
    saveState();
  });

  audio.addEventListener("ended", () => {
    if (audio.loop) return;
    const nextIndex = (state.trackIndex + 1) % playlist.length;
    loadTrack(nextIndex, false);
    tryPlay();
  });

  ["mousedown", "keydown", "touchstart", "wheel"].forEach((eventName) => {
    window.addEventListener(eventName, startFromUserGesture, { passive: true });
  });

  window.addEventListener("pagehide", saveState);
  window.addEventListener("beforeunload", saveState);

  function showPlayer() {
    ui.root.style.display = 'flex';
  }

  const hasSplash = !!document.getElementById('splash-screen');

  applyMeta();
  updateButtons();
  updateDownloadLink();

  if (!hasSplash) {
    audio.addEventListener('playing', showPlayer, { once: true });
  }

  window.helloldMusic = {
    startFromUserGesture,
    show: showPlayer,
    getState: function () {
      return { ...state };
    }
  };
})();
