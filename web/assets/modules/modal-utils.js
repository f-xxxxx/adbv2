(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.classList.remove("hidden");
    return true;
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.classList.add("hidden");
    return true;
  }

  root.modalUtils = {
    openModal,
    closeModal,
  };
})();

