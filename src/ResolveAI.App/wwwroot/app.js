// Browser actions the C# components ask for.
window.resolveai = {
  scrollToId(id, block = "center") {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block });
  },
  copy(text) {
    return navigator.clipboard.writeText(text);
  },
  closeMenu(id) {
    document.getElementById(id)?.removeAttribute("open");
  },
};

document.addEventListener("click", event => {
  const menu = document.getElementById("application-menu");
  if (menu?.hasAttribute("open") && !menu.contains(event.target)) {
    menu.removeAttribute("open");
  }
});
