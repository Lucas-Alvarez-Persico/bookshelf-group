/* =========================================================
   Quesosquad's Bookshelf — Supabase (auth + votos por perfil)
   ========================================================= */

const MAX_BOOKS = 5;

let supabaseClient = null;
let currentUser = null;
let currentProfile = null;

let appData = {
  settings: { member_count: 4, voting_round: 1, runoff_candidate_ids: null },
  candidates: [],
  votes: [],
  myVote: null,
  current: null,
  history: [],
  profiles: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function isConfigured() {
  return SUPABASE_URL && SUPABASE_ANON_KEY
    && !SUPABASE_URL.includes("TU-PROYECTO")
    && !SUPABASE_ANON_KEY.includes("TU_ANON");
}

function isAdmin() {
  return currentProfile?.role === "admin";
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/* ---------- Supabase init ---------- */
function initSupabase() {
  if (!isConfigured()) {
    console.warn("Configurá config.js con tus credenciales de Supabase.");
    return false;
  }
  if (!window.supabase) {
    console.error("No se cargó la librería de Supabase.");
    return false;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

function ensureSupabase() {
  if (supabaseClient) return true;
  setAuthError("Configurá config.js con tu URL y anon key de Supabase.");
  return false;
}

async function loadAllData() {
  const [settingsRes, candidatesRes, votesRes, currentRes, historyRes] = await Promise.all([
    supabaseClient.from("app_settings").select("*").eq("id", 1).single(),
    supabaseClient.from("candidates").select("*").order("created_at"),
    supabaseClient.from("votes").select("*"),
    supabaseClient.from("current_reading").select("*").eq("id", 1).single(),
    supabaseClient.from("history").select("*").order("finished_at", { ascending: false }),
  ]);

  if (settingsRes.error) throw settingsRes.error;
  appData.settings = settingsRes.data;
  appData.candidates = candidatesRes.data || [];
  appData.votes = votesRes.data || [];
  appData.current = currentRes.data?.title ? currentRes.data : null;
  appData.history = historyRes.data || [];

  if (currentUser) {
    const round = appData.settings.voting_round;
    appData.myVote = appData.votes.find(
      (v) => v.user_id === currentUser.id && v.voting_round === round
    ) || null;
  } else {
    appData.myVote = null;
  }
}

async function loadProfiles() {
  const { data, error } = await supabaseClient.from("profiles").select("*").order("created_at");
  if (error) throw error;
  appData.profiles = data || [];
}

function votePool() {
  const { runoff_candidate_ids } = appData.settings;
  if (runoff_candidate_ids?.length) {
    return appData.candidates.filter((b) => runoff_candidate_ids.includes(b.id));
  }
  return appData.candidates;
}

function voteCounts() {
  const round = appData.settings.voting_round;
  const poolIds = new Set(votePool().map((b) => b.id));
  const counts = {};
  appData.votes
    .filter((v) => v.voting_round === round && poolIds.has(v.candidate_id))
    .forEach((v) => {
      counts[v.candidate_id] = (counts[v.candidate_id] || 0) + 1;
    });
  return counts;
}

function totalVotes() {
  const round = appData.settings.voting_round;
  const poolIds = new Set(votePool().map((b) => b.id));
  return appData.votes.filter(
    (v) => v.voting_round === round && poolIds.has(v.candidate_id)
  ).length;
}

/* ---------- Auth ---------- */
function getSupabaseProjectRef() {
  try {
    return new URL(SUPABASE_URL).hostname.split(".")[0];
  } catch {
    return null;
  }
}

function clearSupabaseAuthStorage() {
  const ref = getSupabaseProjectRef();
  Object.keys(localStorage).forEach((key) => {
    if (!key.startsWith("sb-")) return;
    if (!ref || key.startsWith(`sb-${ref}-`)) localStorage.removeItem(key);
  });
}

async function signOutCompletely() {
  clearSupabaseAuthStorage();
  if (!supabaseClient) return;
  try {
    await supabaseClient.auth.signOut({ scope: "local" });
  } catch (_) {
    // Si falla la red, igual limpiamos local.
  }
  clearSupabaseAuthStorage();
}

function resetAuthState() {
  currentUser = null;
  currentProfile = null;
  appData.myVote = null;
  $("#adminBtn").classList.add("hidden");
  closeAdmin();
  $("#loginPassword").value = "";
  setAuthError("");
  showAuth();
}

function showAuth() {
  $("#bookSpread").classList.add("auth-required");
  $("#authOverlay").classList.remove("hidden");
  $("#userChip").classList.add("hidden");
}

function hideAuth() {
  $("#bookSpread").classList.remove("auth-required");
  $("#authOverlay").classList.add("hidden");
  $("#userChip").classList.remove("hidden");
  $("#userName").textContent = currentProfile?.display_name || currentUser?.email || "";
}

function setAuthError(msg) {
  const el = $("#authError");
  if (msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
  $("#authSuccess").classList.add("hidden");
}

function setAuthSuccess(msg) {
  const el = $("#authSuccess");
  el.textContent = msg;
  el.classList.remove("hidden");
  setAuthError("");
}

async function loadSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    currentUser = null;
    currentProfile = null;
    return false;
  }
  currentUser = session.user;
  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();
  if (error) throw error;
  currentProfile = profile;
  return true;
}

async function onAuthSuccess() {
  await loadSession();
  hideAuth();
  if (isAdmin()) $("#adminBtn").classList.remove("hidden");
  await loadAllData();
  render();
}

async function handleLogin(e) {
  e.preventDefault();
  if (!ensureSupabase()) return;
  setAuthError("");
  const identifier = $("#loginIdentifier").value.trim();
  const password = $("#loginPassword").value;
  let email = identifier;

  if (!looksLikeEmail(identifier)) {
    const { data, error } = await supabaseClient.rpc("resolve_login_email", {
      login_input: identifier,
    });
    if (error) {
      setAuthError("No se pudo validar el nombre: " + error.message);
      return;
    }
    if (!data) {
      setAuthError("No existe un perfil con ese nombre.");
      return;
    }
    email = data;
  }

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    setAuthError(error.message);
    return;
  }
  await onAuthSuccess();
}

async function handleRegister(e) {
  e.preventDefault();
  if (!ensureSupabase()) return;
  setAuthError("");
  const display_name = $("#registerName").value.trim();
  const email = $("#registerEmail").value.trim();
  const password = $("#registerPassword").value;
  if (!display_name) {
    setAuthError("Poné un nombre para el club.");
    return;
  }
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { display_name } },
  });
  if (error) {
    setAuthError(error.message);
    return;
  }
  if (data.session) {
    await onAuthSuccess();
  } else {
    setAuthSuccess("Cuenta creada. Revisá tu email para confirmar y luego ingresá.");
  }
}

async function handleLogout(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  resetAuthState();
  await signOutCompletely();
}

function switchAuthTab(tab) {
  $$(".auth-tab").forEach((b) => b.classList.toggle("active", b.dataset.authTab === tab));
  $("#loginForm").classList.toggle("hidden", tab !== "login");
  $("#registerForm").classList.toggle("hidden", tab !== "register");
  setAuthError("");
  $("#authSuccess").classList.add("hidden");
}

/* ---------- Navegación ---------- */
function showTab(view) {
  $$(".tab-btn[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#view-history").classList.toggle("hidden", view !== "history");
  const onHome = view === "home";
  if (appData.current?.title) {
    $("#view-current").classList.toggle("hidden", !onHome);
    $("#view-vote").classList.add("hidden");
  } else {
    $("#view-vote").classList.toggle("hidden", !onHome);
    $("#view-current").classList.add("hidden");
  }
}

function render() {
  if (!currentUser) return;
  renderVote();
  renderCurrent();
  renderHistory();
  const active = document.querySelector(".tab-btn.active")?.dataset.view || "home";
  showTab(active);
}

/* ---------- Votación ---------- */
function renderVote() {
  const grid = $("#voteGrid");
  const empty = $("#voteEmpty");
  const progress = $("#voteProgress");
  grid.innerHTML = "";

  const pool = votePool();

  if (pool.length === 0) {
    empty.classList.remove("hidden");
    progress.innerHTML = "";
    progress.classList.add("hidden");
    $("#voteSubtitle").textContent = "Elegí el próximo libro del grupo.";
    return;
  }
  empty.classList.add("hidden");
  progress.classList.remove("hidden");

  const runoff = appData.settings.runoff_candidate_ids?.length;
  $("#voteSubtitle").textContent = runoff
    ? "¡Hubo empate! Volvé a votar entre los libros igualados."
    : "Elegí el próximo libro del grupo. Podés cambiar tu voto cuando quieras.";

  const counts = voteCounts();
  const voted = totalVotes();
  const members = appData.settings.member_count;
  const pct = Math.min(100, Math.round((voted / members) * 100));
  progress.innerHTML = `
    <span>🗳️ <b>${voted}</b> / ${members} votos</span>
    <div class="pbar"><span style="width:${pct}%"></span></div>`;

  const myCandidateId = appData.myVote?.candidate_id;

  pool.forEach((book) => {
    const count = counts[book.id] || 0;
    const isMine = myCandidateId === book.id;
    const card = document.createElement("div");
    card.className = "book-card";
    card.innerHTML = `
      ${book.cover_url
        ? `<img class="cover" src="${book.cover_url}" alt="${escapeHtml(book.title)}" />`
        : `<div class="cover placeholder">📕</div>`}
      <div class="card-body">
        <span class="card-title">${escapeHtml(book.title)}</span>
        <span class="votes-count"><b>${count}</b> voto${count === 1 ? "" : "s"}</span>
        <button class="btn btn-vote ${isMine ? "mine" : "btn-primary"}" data-vote="${book.id}">
          ${isMine ? "✓ Tu voto" : "Votar"}
        </button>
      </div>`;
    grid.appendChild(card);
  });

  grid.querySelectorAll("[data-vote]").forEach((btn) => {
    btn.addEventListener("click", () => castVote(btn.dataset.vote));
  });
}

async function castVote(candidateId) {
  if (!currentUser) {
    showAuth();
    return;
  }

  const round = appData.settings.voting_round;
  const payload = {
    user_id: currentUser.id,
    candidate_id: candidateId,
    voting_round: round,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabaseClient
    .from("votes")
    .upsert(payload, { onConflict: "user_id,voting_round" });

  if (error) {
    alert("No se pudo registrar el voto: " + error.message);
    return;
  }

  await loadAllData();
  render();

  if (totalVotes() >= appData.settings.member_count) {
    await tallyVotes();
  }
}

async function tallyVotes() {
  const { data, error } = await supabaseClient.rpc("tally_votes_if_complete");
  if (error) {
    alert("Error al contar votos: " + error.message);
    return;
  }

  await loadAllData();
  render();

  if (data?.status === "runoff") {
    setTimeout(() => alert("¡Empate! Se abre una nueva ronda entre los libros igualados."), 50);
  } else if (data?.status === "winner") {
    showTab("home");
    setTimeout(() => alert(`📖 ¡Ganó "${data.title}"! El admin puede configurar la lectura.`), 50);
  }
}

/* ---------- Libro activo ---------- */
function renderCurrent() {
  const c = appData.current;
  if (!c?.title) return;
  $("#currentCover").src = c.cover_url || "";
  $("#currentTitle").textContent = c.title;
  $("#currentDate").textContent = c.read_date ? formatDate(c.read_date) : "Por definir";
  $("#currentChapters").textContent = c.chapters || "Por definir";
  setupDownload($("#dlPdf"), c.pdf_url, "PDF");
  setupDownload($("#dlEpub"), c.epub_url, "EPUB");
}

function setupDownload(el, url, label) {
  if (url) {
    el.href = url;
    el.classList.remove("disabled");
    el.textContent = `⬇ ${label}`;
  } else {
    el.removeAttribute("href");
    el.classList.add("disabled");
    el.textContent = `${label} (no disponible)`;
  }
}

/* ---------- Historial ---------- */
function renderHistory() {
  const shelves = $("#shelves");
  const empty = $("#historyEmpty");
  shelves.innerHTML = "";

  if (!appData.history.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const perShelf = 5;
  for (let i = 0; i < appData.history.length; i += perShelf) {
    const group = appData.history.slice(i, i + perShelf);
    const shelf = document.createElement("div");
    shelf.className = "shelf";
    const row = document.createElement("div");
    row.className = "shelf-books";
    group.forEach((b) => {
      const item = document.createElement("div");
      item.className = "shelf-book";
      item.innerHTML = `
        ${b.cover_url ? `<img src="${b.cover_url}" alt="${escapeHtml(b.title)}" />`
          : `<div class="cover placeholder" style="width:120px;aspect-ratio:2/3;display:flex;align-items:center;justify-content:center;background:var(--bg-elevated);border-radius:4px;">📘</div>`}
        <div class="sb-title">${escapeHtml(b.title)}</div>
        <div class="sb-date">${b.finished || ""}</div>`;
      row.appendChild(item);
    });
    shelf.appendChild(row);
    shelves.appendChild(shelf);
  }
}

/* ---------- Admin ---------- */
function openAdmin() {
  if (!isAdmin()) {
    alert("No tenés permisos de administrador.");
    return;
  }
  $("#adminOverlay").classList.remove("hidden");
  renderAdmin();
}

function closeAdmin() {
  $("#adminOverlay").classList.add("hidden");
}

async function renderAdmin() {
  await loadProfiles();
  $("#memberCount").value = appData.settings.member_count;

  const userList = $("#adminUserList");
  userList.innerHTML = "";
  appData.profiles.forEach((p) => {
    const item = document.createElement("div");
    item.className = "admin-user-item";
    const isSelf = p.id === currentUser?.id;
    item.innerHTML = `
      <span class="aui-name">${escapeHtml(p.display_name)}</span>
      <span class="aui-role ${p.role === "admin" ? "is-admin" : ""}">${p.role}</span>
      <button class="aui-remove" data-delete-user="${p.id}" title="Borrar usuario"
        ${isSelf || p.role === "admin" ? "disabled" : ""}>🗑</button>`;
    userList.appendChild(item);
  });
  userList.querySelectorAll("[data-delete-user]").forEach((btn) => {
    btn.addEventListener("click", () => deleteUser(btn.dataset.deleteUser));
  });

  const list = $("#adminBookList");
  list.innerHTML = "";
  appData.candidates.forEach((b) => {
    const item = document.createElement("div");
    item.className = "admin-book-item";
    item.innerHTML = `
      ${b.cover_url ? `<img src="${b.cover_url}" alt="" />` : `<img alt="" />`}
      <span class="abi-title">${escapeHtml(b.title)}</span>
      <button class="abi-remove" data-remove="${b.id}" title="Quitar">🗑</button>`;
    list.appendChild(item);
  });
  list.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => removeCandidate(btn.dataset.remove));
  });

  $("#addBookBtn").disabled = appData.candidates.length >= MAX_BOOKS;
  $("#addBookBtn").textContent =
    appData.candidates.length >= MAX_BOOKS ? "Máximo alcanzado" : "Agregar";

  if (appData.current?.title) {
    $("#noWinnerMsg").classList.add("hidden");
    $("#winnerControls").classList.remove("hidden");
    $("#winnerName").textContent = appData.current.title;
    $("#readDate").value = appData.current.read_date || "";
    $("#readChapters").value = appData.current.chapters || "";
    $("#pdfUrl").value = appData.current.pdf_url || "";
    $("#epubUrl").value = appData.current.epub_url || "";
  } else {
    $("#noWinnerMsg").classList.remove("hidden");
    $("#winnerControls").classList.add("hidden");
  }
}

async function deleteUser(userId) {
  const profile = appData.profiles.find((p) => p.id === userId);
  if (!profile) return;
  if (!confirm(`¿Borrar la cuenta de "${profile.display_name}"?`)) return;
  const { error } = await supabaseClient.rpc("admin_delete_user", { target_id: userId });
  if (error) {
    alert("No se pudo borrar: " + error.message);
    return;
  }
  await renderAdmin();
  await loadAllData();
  render();
}

async function removeCandidate(id) {
  await supabaseClient.from("candidates").delete().eq("id", id);
  await supabaseClient.from("votes").delete().eq("candidate_id", id);
  await loadAllData();
  renderAdmin();
  render();
}

let pendingCoverFile = null;

async function uploadCover(file) {
  const ext = file.name.split(".").pop() || "png";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabaseClient.storage.from("covers").upload(path, file, { upsert: false });
  if (error) throw error;
  const { data } = supabaseClient.storage.from("covers").getPublicUrl(path);
  return data.publicUrl;
}

async function handleAddBook() {
  const title = $("#newBookTitle").value.trim();
  if (!title) { alert("Poné un título."); return; }
  if (appData.candidates.length >= MAX_BOOKS) return;

  let cover_url = null;
  if (pendingCoverFile) {
    try {
      cover_url = await uploadCover(pendingCoverFile);
    } catch (e) {
      alert("Error al subir la tapa: " + e.message);
      return;
    }
  }

  const { error } = await supabaseClient.from("candidates").insert({ title, cover_url });
  if (error) { alert(error.message); return; }

  pendingCoverFile = null;
  $("#newBookTitle").value = "";
  $("#newBookCover").value = "";
  $("#fileLabelText").textContent = "📁 Subir tapa (PNG)";
  await loadAllData();
  renderAdmin();
  render();
}

/* ---------- Portada: abrir / cerrar libro ---------- */
function openBook() {
  const cover = $("#coverBook");
  const scene = $("#scene");
  const spread = $("#bookSpread");
  if (cover.classList.contains("is-open")) return;
  cover.classList.add("is-open");
  setTimeout(() => {
    scene.classList.add("opened");
    spread.classList.remove("hidden");
    void spread.offsetWidth;
    spread.classList.add("is-visible");
  }, 480);
  setTimeout(async () => {
    spread.classList.add("content-in");
    if (!supabaseClient) {
      showAuth();
      setAuthError("Configurá config.js con tu URL y anon key de Supabase para usar el club.");
      return;
    }
    if (!currentUser) {
      showAuth();
    } else {
      hideAuth();
      try {
        await loadAllData();
        render();
      } catch (e) {
        console.error(e);
      }
    }
  }, 1180);
}

function closeBook() {
  const cover = $("#coverBook");
  const scene = $("#scene");
  const spread = $("#bookSpread");
  spread.classList.remove("content-in");
  setTimeout(() => spread.classList.remove("is-visible"), 380);
  setTimeout(() => {
    spread.classList.add("hidden");
    scene.classList.remove("opened");
    cover.classList.remove("is-open");
  }, 1050);
}

/* ---------- Eventos ---------- */
function bindEvents() {
  $("#coverBook").addEventListener("click", openBook);
  $("#coverBook").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openBook(); }
  });
  $("#closeBook").addEventListener("click", closeBook);

  $$(".tab-btn[data-view]").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.view)));

  $$(".auth-tab").forEach((b) =>
    b.addEventListener("click", () => switchAuthTab(b.dataset.authTab)));
  $("#loginForm").addEventListener("submit", handleLogin);
  $("#registerForm").addEventListener("submit", handleRegister);

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      if (!isAdmin()) return;
      $("#adminBtn").classList.toggle("hidden");
    }
  });
  $("#adminBtn").addEventListener("click", openAdmin);
  $("#adminClose").addEventListener("click", closeAdmin);
  $("#adminOverlay").addEventListener("click", (e) => {
    if (e.target === $("#adminOverlay")) closeAdmin();
  });

  $("#saveMembers").addEventListener("click", async () => {
    const n = parseInt($("#memberCount").value, 10);
    if (n < 1) return;
    const { error } = await supabaseClient.from("app_settings").update({ member_count: n }).eq("id", 1);
    if (error) { alert(error.message); return; }
    await loadAllData();
    render();
    alert("Integrantes guardados.");
  });

  $("#newBookCover").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingCoverFile = file;
    $("#fileLabelText").textContent = "✓ " + file.name;
  });
  $("#addBookBtn").addEventListener("click", handleAddBook);

  $("#resetVotesBtn").addEventListener("click", async () => {
    if (!confirm("¿Reiniciar todos los votos y el desempate?")) return;
    const { error } = await supabaseClient.rpc("admin_reset_votes");
    if (error) { alert(error.message); return; }
    await loadAllData();
    renderAdmin();
    render();
  });

  $("#saveReading").addEventListener("click", async () => {
    if (!appData.current?.title) return;
    const { error } = await supabaseClient.from("current_reading").update({
      read_date: $("#readDate").value || null,
      chapters: $("#readChapters").value.trim() || null,
      pdf_url: $("#pdfUrl").value.trim() || null,
      epub_url: $("#epubUrl").value.trim() || null,
    }).eq("id", 1);
    if (error) { alert(error.message); return; }
    await loadAllData();
    render();
    alert("Lectura guardada.");
  });

  $("#finishBook").addEventListener("click", async () => {
    const c = appData.current;
    if (!c?.title) return;
    if (!confirm(`¿Marcar "${c.title}" como terminado y mandarlo al historial?`)) return;
    await supabaseClient.from("history").insert({
      title: c.title,
      cover_url: c.cover_url,
      finished: new Date().toLocaleDateString("es-AR", { month: "short", year: "numeric" }),
    });
    await supabaseClient.from("current_reading").update({
      title: null, cover_url: null, read_date: null,
      chapters: null, pdf_url: null, epub_url: null,
    }).eq("id", 1);
    await loadAllData();
    renderAdmin();
    render();
    showTab("home");
  });

  $("#wipeAll").addEventListener("click", async () => {
    if (!confirm("Esto borra TODO (votos, candidatos, libro actual e historial). ¿Seguro?")) return;
    const { error } = await supabaseClient.rpc("admin_wipe_all");
    if (error) { alert(error.message); return; }
    closeAdmin();
    await loadAllData();
    render();
  });
}

/* ---------- Arranque ---------- */
async function boot() {
  bindEvents();

  if (!initSupabase()) return;

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_OUT" || (event === "INITIAL_SESSION" && !session)) {
      resetAuthState();
      return;
    }
    if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session) {
      currentUser = session.user;
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("*")
        .eq("id", currentUser.id)
        .single();
      currentProfile = profile;
      hideAuth();
      if (isAdmin()) $("#adminBtn").classList.remove("hidden");
      try {
        await loadAllData();
        render();
      } catch (err) {
        console.error(err);
      }
    }
  });

  const hasSession = await loadSession();
  if (hasSession) {
    hideAuth();
    if (isAdmin()) $("#adminBtn").classList.remove("hidden");
    try {
      await loadAllData();
      render();
    } catch (e) {
      console.error(e);
    }
  }
}

boot();

window.handleLogout = handleLogout;
