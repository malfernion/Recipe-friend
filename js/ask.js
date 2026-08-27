/**
 * ask.js — the one question the app asks before doing something that
 * cannot be undone.
 *
 * This was window.confirm. The wording at every call site was already
 * careful — "Leave 'X'? Its recipes stay with the book." — but it
 * arrived in a grey system box, in the system font, with OK and Cancel,
 * in an app that has designed every other surface it shows. Only the box
 * has changed; the words are the ones that were there.
 *
 * Answering is a promise, so every call site awaits it. The button
 * carries the verb rather than saying OK, which is what lets someone
 * read the button instead of the paragraph.
 *
 * Escape and a click on the backdrop both mean no. That falls out of a
 * <dialog> with an empty returnValue, so there is no third answer to
 * handle: anything that is not "yes" is a no.
 */
(function (global) {
  "use strict";

  /**
   * @param {string} message  what will happen, in full sentences
   * @param {{confirmLabel?: string, danger?: boolean}} [options]
   * @returns {Promise<boolean>} true only if the person said yes
   */
  function ask(message, options) {
    const opts = options || {};
    const doc = global.document;
    const dialog = doc.querySelector("#confirm-dialog");
    const yes = doc.querySelector("#confirm-yes");

    doc.querySelector("#confirm-message").textContent = message;
    yes.textContent = opts.confirmLabel || "OK";
    yes.classList.toggle("btn-danger", opts.danger === true);
    yes.classList.toggle("btn-primary", opts.danger !== true);

    return new Promise((resolve) => {
      const answered = () => {
        dialog.removeEventListener("close", answered);
        resolve(dialog.returnValue === "yes");
      };
      dialog.addEventListener("close", answered);
      dialog.returnValue = "";
      dialog.showModal();
    });
  }

  global.RecipeAsk = { ask };
})(window);
