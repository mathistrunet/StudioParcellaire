/**
 * Point d'entrée unique de MapLibre dans l'application.
 *
 * Depuis la version 6, un bundler doit indiquer lui-même l'URL du worker, sinon les
 * tuiles et les données GeoJSON ne se chargent pas. Passer par ce module garantit que
 * c'est fait avant la création de toute carte. MapLibre n'a plus d'export par défaut :
 * on le fournit ici pour garder la même écriture partout.
 */
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

maplibregl.setWorkerUrl(workerUrl);

export default maplibregl;
