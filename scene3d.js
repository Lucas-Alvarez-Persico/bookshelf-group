/* =========================================================
   Escena 3D de la portada: cartel + movimiento de cámara
   ========================================================= */
(function () {
  const scene = document.getElementById("scene");
  const sign = document.getElementById("introSign");
  const toast = document.getElementById("soonToast");

  function enterRoom() {
    if (scene.classList.contains("at-table")) return;
    sign.classList.add("sign-away");
    scene.classList.add("at-table");
  }

  sign.addEventListener("click", (e) => {
    e.stopPropagation();
    enterRoom();
  });
  sign.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      enterRoom();
    }
  });
  // durante la intro, cualquier click en la escena también entra
  scene.addEventListener("click", () => {
    if (!scene.classList.contains("at-table")) enterRoom();
  });

  let toastTimer = null;
  function showSoon(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  // cámara y fichero: por ahora solo un aviso, los menús vienen después
  function bindStub(id, msg) {
    const el = document.getElementById(id);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      el.classList.remove("wiggle");
      void el.offsetWidth; // reinicia la animación
      el.classList.add("wiggle");
      showSoon(msg);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        el.click();
      }
    });
  }
  bindStub("camItem", "🎬 Videoteca de la Quesosquad — próximamente");
  bindStub("archiveItem", "🗃️ Fichero de datos — próximamente");
})();
