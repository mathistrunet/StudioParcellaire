import Modal from "./Modal";
import { IMPORT_FORMATS } from "../services/parcellaireImport";

const STEPS = [
  {
    title: "1 · Charger votre parcellaire",
    text: (
      <>
        Cliquez sur <strong>Importer</strong> dans la barre du haut et choisissez votre
        fichier. L'outil détecte seul le format et recale les coordonnées en WGS84.
        Aucun fichier n'est envoyé sur Internet : tout reste sur votre poste.
      </>
    ),
  },
  {
    title: "2 · Corriger les contours",
    text: (
      <>
        Les outils de dessin sont regroupés en bas de l'écran :{" "}
        <strong>dessiner</strong> une parcelle manquante, <strong>découper</strong> une
        parcelle en deux, <strong>fusionner</strong> plusieurs parcelles ou{" "}
        <strong>supprimer</strong> la sélection. Cliquez une parcelle sur la carte pour la
        sélectionner ; les parcelles qui se chevauchent sont signalées en rouge.
      </>
    ),
  },
  {
    title: "3 · Renseigner les informations",
    text: (
      <>
        Le panneau de droite liste vos parcelles dans un tableau : vous y saisissez en
        série le nom, la conduite AB, l&apos;irrigabilité, les cultures N+1 à N-6 et le type
        de sol. Les cultures se saisissent par nom ou par code Télépac, avec autocomplétion.
        Le bouton <strong>Colonnes</strong> masque celles dont vous n&apos;avez pas besoin.
      </>
    ),
  },
  {
    title: "4 · Exporter le résultat",
    text: (
      <>
        <strong>Exporter</strong> propose trois sorties. Le <strong>CSV Assolia</strong>{" "}
        emporte les cultures N à N-4, la surface, la conduite AB, l&apos;irrigabilité et le
        type de sol — N+1, N-5 et N-6 ne font pas partie du format. Le{" "}
        <strong>XML Télépac</strong> ne contient qu&apos;une seule année, celle de la colonne
        que vous désignez. Le <strong>shapefile</strong> (.zip, Lambert-93) n&apos;emporte
        que les cultures N et N-1, sans conduite AB ni irrigabilité. Une fenêtre demande les
        informations nécessaires avant le téléchargement.
      </>
    ),
  },
];

// Première utilisation : ce qu'il faut savoir avant de commencer.
const FIRST_RUN = [
  {
    label: "Démarrer l'outil",
    text: "Double-cliquez sur StudioParcellaire.exe. Le lanceur prépare l'application puis ouvre votre navigateur ; laissez sa fenêtre ouverte pendant l'utilisation, la fermer arrête l'outil.",
  },
  {
    label: "Aucun parcellaire au départ",
    text: "L'outil démarre vide, c'est normal. Importez votre fichier ou dessinez vos premières parcelles ; le travail en cours est ensuite enregistré automatiquement sur votre poste.",
  },
  {
    label: "Fonds de carte",
    text: "Le fond satellite et les couches d'aide au repérage s'activent dans l'onglet Calques. Certaines cartes (sols, toponymie) se téléchargent toutes seules la première fois que vous les affichez sur un secteur.",
  },
  {
    label: "Confidentialité",
    text: "Votre parcellaire ne quitte jamais votre poste : seules les tuiles des fonds de carte et les couches publiques sont téléchargées depuis Internet.",
  },
];

// Sorties proposées par le bouton Exporter.
const EXPORT_FORMATS = [
  {
    label: "CSV Assolia",
    extension: ".csv",
    text: "Assolement complet, une ligne par parcelle : identification de l'exploitation, surface, conduite AB, irrigabilité, type de sol, cultures N à N-4 et contour. C'est la sortie à utiliser pour alimenter Assolia.",
  },
  {
    label: "XML Télépac",
    extension: ".xml",
    text: "Fichier de déclaration au format Télépac : îlots, parcelles et code culture. Une fenêtre demande quelle colonne de culture alimente le code, puisqu'un fichier Télépac n'en porte qu'une seule.",
  },
  {
    label: "Shapefile",
    extension: ".zip",
    text: "Archive contenant .shp, .dbf, .shx et .prj, pour un SIG (QGIS, ArcGIS) ou un outil tiers. Demande le nom de l'exploitation et la campagne, écrits dans les attributs RAIS_SOCIA et CAMPAGNE.",
  },
];

// Colonnes du CSV Assolia, dans l'ordre du fichier généré.
const CSV_COLUMNS = [
  ["Secteur", "Saisi dans la fenêtre d'export, identique pour toutes les parcelles."],
  ["Exploitation", "Saisi dans la fenêtre d'export. Donne aussi son nom au fichier téléchargé."],
  ["Numero pacage", "Saisi dans la fenêtre d'export ; pré-rempli depuis un import Télépac."],
  ["Parcelles", "Nom de la parcelle. À défaut : « Parcelle 1 », « Parcelle 2 »…"],
  ["Surface parcelle", "En hectares, calculée depuis la géométrie si elle n'est pas renseignée."],
  ["Parcelle Bio", "« Oui » si la case AB est cochée, « Non » sinon."],
  ["Type de sol", "Texte saisi librement, éventuellement renommé à l'export."],
  ["Irrigabilité", "« Oui » si la case Irrigable est cochée, « Non » sinon."],
  ["CultureN à CultureN4", "Cultures de l'année en cours puis des quatre précédentes."],
  ["Geometrie", "Contour de la parcelle en longitude/latitude (WGS84)."],
];

const CSV_RULES = [
  {
    label: "Cultures et nom de structure",
    text: "Si vous renseignez un nom de structure, chaque culture est traduite en libellé de cette structure. Une culture sans correspondance devient « Autre assolé » ; une case vide reste vide (pas de culture cette année-là). Sans nom de structure, les libellés sont exportés tels quels.",
  },
  {
    label: "Colonnes N-5 et N-6",
    text: "Le CSV Assolia s'arrête à N-4. Les cultures saisies en N-5 et N-6 restent dans l'outil mais ne sont pas exportées.",
  },
  {
    label: "Type de sol",
    text: "La fenêtre d'export permet de renommer chaque type de sol rencontré, et d'attribuer une valeur commune aux parcelles qui n'en ont pas. Un champ laissé vide conserve la valeur d'origine.",
  },
  {
    label: "Format du fichier",
    text: "Séparateur point-virgule, une ligne d'en-tête, une ligne par parcelle. Les parcelles sans contour exploitable sont ignorées.",
  },
];

const TIPS = [
  {
    label: "Sauvegarde",
    text: "Vos modifications sont enregistrées automatiquement sur votre poste : vous pouvez fermer et rouvrir l'outil sans rien perdre. « Réinitialiser » efface tout le parcellaire courant.",
  },
  {
    label: "Plusieurs millésimes",
    text: "Importez plusieurs fichiers d'années différentes : chaque parcelle porte son année. Le filtre « Année » du panneau restreint la carte, le tableau et les actions en série à un seul millésime. « Comparer deux millésimes » associe les parcelles d'une année à l'autre : l'année conservée doit être la plus récente, et l'historique de l'année qui disparaît est décalé du nombre d'années qui les sépare.",
  },
  {
    label: "Fonds de carte",
    text: "L'onglet Calques active le fond satellite, le plan IGN, le RPG et les autres couches d'aide au repérage. Un clic sur la carte affiche les informations des couches interrogeables.",
  },
  {
    label: "Type de sol",
    text: "La colonne « Type de sol » se saisit à la main ou se remplit depuis SoilGrids (boutons en tête de colonne). L'onglet « Sols présentés » associe les sols de la carte des sols France aux types de votre structure. Ces services interrogent des serveurs en ligne.",
  },
  {
    label: "Aller-retour CSV",
    text: "Un CSV exporté peut être réimporté dans l'outil : nom, surface, bio, irrigabilité, type de sol, cultures et contours sont relus tels quels.",
  },
  {
    label: "Mise à jour des cartes",
    text: "Les cartes des sols et de toponymie sont téléchargées à la demande. Si une carte est corrigée par la suite, un encart le signale dans l'onglet Calques : « Mettre à jour » suffit, la nouvelle version est reprise au prochain affichage.",
  },
];

const guideCellHeadStyle = {
  textAlign: "left",
  verticalAlign: "top",
  padding: "7px 10px",
  width: "32%",
  fontWeight: 600,
  wordBreak: "break-word",
};

const guideCellStyle = {
  padding: "7px 10px",
  color: "var(--c-text-soft)",
  lineHeight: 1.5,
};

export default function GuideModal({ open, onClose }) {
  return (
    <Modal
      open={open}
      title="Comment fonctionne l'outil"
      subtitle="Importer un parcellaire, le corriger, le compléter, puis l'exporter. Quatre étapes, dans cet ordre."
      onClose={onClose}
      width={780}
      footer={
        <>
          <span className="fp-hint">
            Ce guide reste accessible à tout moment via le bouton{" "}
            <strong>Guide</strong> en haut à droite.
          </span>
          <button
            type="button"
            className="fp-btn fp-btn--primary"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
          >
            J'ai compris
          </button>
        </>
      }
    >
      <ol className="fp-steps">
        {STEPS.map((step, index) => (
          <li key={step.title} className="fp-step">
            <span className="fp-step__num">{index + 1}</span>
            <div>
              <h3 className="fp-step__title">{step.title.replace(/^\d+ · /, "")}</h3>
              <p className="fp-step__text">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <div style={{ marginTop: 20 }}>
        <h3 className="fp-section-title">Première utilisation</h3>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {FIRST_RUN.map((item) => (
            <div key={item.label} className="fp-card fp-card--muted" style={{ padding: 12 }}>
              <div style={{ fontSize: "var(--fs-md)", fontWeight: 700, marginBottom: 3 }}>
                {item.label}
              </div>
              <p className="fp-hint">{item.text}</p>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <h3 className="fp-section-title">Formats de parcellaire acceptés à l'import</h3>
        <div
          style={{
            border: "1px solid var(--c-border)",
            borderRadius: "var(--r-md)",
            overflow: "hidden",
            marginTop: 8,
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "var(--fs-sm)",
              tableLayout: "fixed",
            }}
          >
            <tbody>
              {IMPORT_FORMATS.map((format, index) => (
                <tr
                  key={format.id}
                  style={{ background: index % 2 ? "var(--c-surface-muted)" : "transparent" }}
                >
                  <th style={guideCellHeadStyle}>
                    {format.label}
                    <div style={{ fontWeight: 400, color: "var(--c-text-faint)", marginTop: 2 }}>
                      {format.extensions.join(", ")}
                    </div>
                  </th>
                  <td style={guideCellStyle}>
                    {format.description}
                    {format.limites ? (
                      <div style={{ color: "var(--c-text-faint)", marginTop: 3 }}>
                        {format.limites}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fp-hint" style={{ marginTop: 8 }}>
          Le format est reconnu automatiquement, y compris si le fichier a été renommé. Les
          coordonnées sont ramenées en WGS84 depuis le Lambert-93, le Web Mercator ou le
          Stereo 70 roumain. Seules les surfaces deviennent des parcelles : les points et les
          lignes présents dans un fichier sont ignorés. Un nouvel import s'ajoute au
          parcellaire existant.
        </p>
      </div>

      <div style={{ marginTop: 20 }}>
        <h3 className="fp-section-title">Formats produits à l'export</h3>
        <div
          style={{
            border: "1px solid var(--c-border)",
            borderRadius: "var(--r-md)",
            overflow: "hidden",
            marginTop: 8,
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "var(--fs-sm)",
              tableLayout: "fixed",
            }}
          >
            <tbody>
              {EXPORT_FORMATS.map((format, index) => (
                <tr
                  key={format.label}
                  style={{ background: index % 2 ? "var(--c-surface-muted)" : "transparent" }}
                >
                  <th style={guideCellHeadStyle}>
                    {format.label}
                    <div style={{ fontWeight: 400, color: "var(--c-text-faint)", marginTop: 2 }}>
                      {format.extension}
                    </div>
                  </th>
                  <td style={guideCellStyle}>{format.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <h3 className="fp-section-title">Ce que contient l'export CSV Assolia</h3>
        <p className="fp-hint" style={{ margin: "8px 0 10px" }}>
          Une ligne par parcelle, dans cet ordre de colonnes :
        </p>
        <div
          style={{
            border: "1px solid var(--c-border)",
            borderRadius: "var(--r-md)",
            overflow: "hidden",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "var(--fs-sm)",
              tableLayout: "fixed",
            }}
          >
            <tbody>
              {CSV_COLUMNS.map(([column, description], index) => (
                <tr
                  key={column}
                  style={{ background: index % 2 ? "var(--c-surface-muted)" : "transparent" }}
                >
                  <th
                    style={{
                      textAlign: "left",
                      verticalAlign: "top",
                      padding: "6px 10px",
                      width: "38%",
                      fontWeight: 600,
                      wordBreak: "break-word",
                    }}
                  >
                    {column}
                  </th>
                  <td
                    style={{
                      padding: "6px 10px",
                      color: "var(--c-text-soft)",
                      lineHeight: 1.5,
                    }}
                  >
                    {description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {CSV_RULES.map((rule) => (
            <div key={rule.label} className="fp-card" style={{ padding: 12 }}>
              <div style={{ fontSize: "var(--fs-md)", fontWeight: 700, marginBottom: 3 }}>
                {rule.label}
              </div>
              <p className="fp-hint">{rule.text}</p>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: 20 }}>
        <h3 className="fp-section-title">Bon à savoir</h3>
        {TIPS.map((tip) => (
          <div key={tip.label} className="fp-card" style={{ padding: 12 }}>
            <div style={{ fontSize: "var(--fs-md)", fontWeight: 700, marginBottom: 3 }}>
              {tip.label}
            </div>
            <p className="fp-hint">{tip.text}</p>
          </div>
        ))}
      </div>
    </Modal>
  );
}
