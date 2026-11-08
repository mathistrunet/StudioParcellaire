/** Route HTTP POST /api/v1/enrich. L'accès (Host, Origin) est contrôlé en amont par le serveur. */
import { prepareApiResponse, readBody, sendBodyError } from "../http-security.mjs";
import { EnrichUpstreamError, EnrichValidationError, validateEnrichRequest } from "./enrich-service.mjs";

const sendJson = (res, status, payload) => {
  res.writeHead(status);
  res.end(JSON.stringify(payload));
};

export function createEnrichHandler({ enrich, maxBodyBytes, onError = () => {} }) {
  return async function handleEnrich(req, res) {
    if (prepareApiResponse(req, res, ["POST"])) return;

    let request;
    try {
      request = validateEnrichRequest(JSON.parse(await readBody(req, maxBodyBytes)));
    } catch (error) {
      if (error instanceof EnrichValidationError) {
        return sendJson(res, 400, { error: error.message, code: error.code });
      }
      if (error instanceof SyntaxError) {
        return sendJson(res, 400, { error: "Le corps n'est pas un JSON valide.", code: "JSON_INVALIDE" });
      }
      return sendBodyError(req, res, error);
    }

    try {
      sendJson(res, 200, await enrich(request));
    } catch (error) {
      onError(error);
      if (error instanceof EnrichUpstreamError) {
        return sendJson(res, error.status, { error: error.message, code: error.code });
      }
      sendJson(res, 500, { error: "Erreur interne du serveur.", code: "ERREUR_INTERNE" });
    }
  };
}
