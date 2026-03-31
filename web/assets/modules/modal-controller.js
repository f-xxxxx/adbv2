(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function createController(modalUtils) {
    function open(id) {
      if (modalUtils && typeof modalUtils.openModal === "function") {
        return modalUtils.openModal(id);
      }
      const el = document.getElementById(id);
      if (!el) return false;
      el.classList.remove("hidden");
      return true;
    }

    function close(id) {
      if (modalUtils && typeof modalUtils.closeModal === "function") {
        return modalUtils.closeModal(id);
      }
      const el = document.getElementById(id);
      if (!el) return false;
      el.classList.add("hidden");
      return true;
    }

    function isOpen(id) {
      const el = document.getElementById(id);
      if (!el) return false;
      return !el.classList.contains("hidden");
    }

    function closeFirstOpen(ids) {
      const list = Array.isArray(ids) ? ids : [];
      for (const id of list) {
        if (isOpen(id)) {
          close(id);
          return id;
        }
      }
      return "";
    }

    return {
      open,
      close,
      isOpen,
      closeFirstOpen,
    };
  }

  root.modalController = {
    createController,
  };
})();
