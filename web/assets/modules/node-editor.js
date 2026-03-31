(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function isLinkRef(value) {
    return (
      Array.isArray(value) &&
      value.length === 2 &&
      (typeof value[0] === "string" || typeof value[0] === "number") &&
      Number.isInteger(value[1])
    );
  }

  function normalizeInputsForSerialize(classType, inputs) {
    const next = { ...(inputs || {}) };
    if (classType === "Swipe") {
      const xNum = Number(next.x);
      const yNum = Number(next.y);
      if (!Number.isFinite(xNum)) delete next.x;
      else next.x = xNum;
      if (!Number.isFinite(yNum)) delete next.y;
      else next.y = yNum;
    } else if (classType === "EasyOCR") {
      delete next.use_all_images;
    }
    return next;
  }

  root.nodeEditor = {
    isLinkRef,
    normalizeInputsForSerialize,
  };
})();

