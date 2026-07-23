// Tema individual (por dispositivo): aplica antes da pintura p/ evitar flash.
// Vive em arquivo próprio — e não inline no index.html — para que a CSP possa
// usar script-src 'self' sem precisar de 'unsafe-inline'.
// Carregado de forma SÍNCRONA no <head>, antes do CSS pintar.
try {
  if (localStorage.getItem("saci-tema") === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  }
} catch (e) { /* localStorage bloqueado (modo privado): segue no tema claro */ }
