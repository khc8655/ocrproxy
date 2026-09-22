/**
 * OCRProxy Admin - Application Entry Point & Lifecycle Bootstrap
 */
document.addEventListener("DOMContentLoaded", async () => {
  // Global Esc key modal close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const activeModal = document.querySelector(".modal.show");
      if (activeModal) {
        closeModal(activeModal.id);
      }
    }
  });

  // Modal backdrop click outside to close (Bootstrap standard dual-phase verification)
  // Prevents modal from closing when dragging mouse to select text inside inputs/modals
  document.querySelectorAll(".modal").forEach((m) => {
    let isBackdropMouseDown = false;

    m.addEventListener("mousedown", (e) => {
      isBackdropMouseDown = (e.target === m);
    });

    m.addEventListener("click", (e) => {
      if (isBackdropMouseDown && e.target === m) {
        closeModal(m.id);
      }
      isBackdropMouseDown = false;
    });
  });

  // Initial Auth & Data Load
  if (state.key) {
    showApp();
    renderNav();
    await loadData();
    // Load presets catalog
    loadPresetsCatalog();
    // Pre-fetch EdgeOne Vault manifest silently
    fetchVaultManifest(true);
  } else {
    showLogin();
  }
});
