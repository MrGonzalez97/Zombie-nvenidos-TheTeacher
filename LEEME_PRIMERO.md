# Zombie-nvenidos v0.68 · cooperativo y celular

## Incluido
- Motor (P / botón móvil): se envía al servidor al cambiar y se conserva en el auto al intercambiar conductor. Vehículos previamente desbloqueados permanecen así para todos.
- Menús de inventario y botín no detienen el tiempo ni la simulación. El menú de pausa sigue deteniendo la simulación individual; en cooperativo el anfitrión continúa simulando el mundo.
- Host: los zombis pueden seleccionar el jugador visible más cercano, incluidos invitados en la misma zona simulada; cuando atacan a un invitado le llega el daño.
- En celular, la barra de acceso rápido queda entre Cerrar y la lista desplazable del inventario.
- +10 puntos de ruido a limpiar cristales (32→42) y forzar puertas (78→88).

## Publicación Render
Mantener `server.js`, `package.json`, `index.html`, `sw.js` e `icons/` juntos en la raíz del repositorio. Configuración: `npm install`, `npm start`, Web Service Node Free.

## Pruebas recomendadas
1. Entrar dos jugadores, desbloquear un vehículo, apagar/encender motor con P y alternar conductor.
2. Abrir inventario mientras otro jugador mueve zombis; comprobar que el reloj y los zombis sigan avanzando.
3. Reordenar rápidamente el HUD fijo desde el inventario móvil.
4. Probar persecuciones y ataques a ambos jugadores dentro de una misma zona.

**Limitación:** la IA host sigue simulando los interiores activos del anfitrión; no se ha convertido a un servidor autoritativo de zombis para todos los interiores simultáneos. No se han realizado pruebas completas entre celulares físicos.
