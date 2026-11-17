import { describe, expect, it } from 'vitest';
import { telepacMesParcellesImporter } from '../lib/importers';
import type { TelepacFeature } from '../lib/types/telepac';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<producteurs xmlns="urn:x-telepac:fr.gouv.agriculture.telepac:echange-producteur-import" xmlns:gml="http://www.opengis.net/gml">
  <producteur numero-pacage="099999998">
    <rpg>
      <ilots>
        <ilot numero-ilot="3" numero-ilot-reference="099999998003">
          <commune>18173</commune>
          <justification>
            <motifOperation>ILOT_M2</motifOperation>
            <justification>Justification fictive de test.</justification>
          </justification>
          <parcelles>
            <parcelle>
              <descriptif-parcelle numero-parcelle="1">
                <commune>18173</commune>
                <culture-principale production-semences="false" production-fermiers="false" deshydratation="false" culture-secondaire="A00" date-labour="000">
                  <code-culture>BTH</code-culture>
                  <precision>001</precision>
                  <reconversion-pp>false</reconversion-pp>
                  <obligation-reimplantation-pp>false</obligation-reimplantation-pp>
                </culture-principale>
                <agri-bio conduite-bio="false" type-conduite-bio="AB" />
                <engagements-maec surface-cible="false" elevage-monogastrique="false" />
              </descriptif-parcelle>
              <geometrie>
                <gml:Polygon>
                  <gml:outerBoundaryIs>
                    <gml:LinearRing>
                      <gml:coordinates>700000,6600000 700100,6600000 700100,6600100 700000,6600100 700000,6600000</gml:coordinates>
                    </gml:LinearRing>
                  </gml:outerBoundaryIs>
                  <gml:innerBoundaryIs>
                    <gml:LinearRing>
                      <gml:coordinates>700020,6600020 700080,6600020 700080,6600080 700020,6600080 700020,6600020</gml:coordinates>
                    </gml:LinearRing>
                  </gml:innerBoundaryIs>
                </gml:Polygon>
              </geometrie>
            </parcelle>
            <parcelle>
              <descriptif-parcelle numero-parcelle="2">
                <culture-principale production-semences="true" production-fermiers="false" deshydratation="true" culture-secondaire="B00" date-labour="20240112">
                  <code-culture>CAG</code-culture>
                  <precision>002</precision>
                  <reconversion-pp>true</reconversion-pp>
                  <obligation-reimplantation-pp>false</obligation-reimplantation-pp>
                </culture-principale>
              </descriptif-parcelle>
              <geometrie>
                <gml:Polygon>
                  <gml:outerBoundaryIs>
                    <gml:LinearRing>
                      <gml:coordinates>701000,6600200 701200,6600200 701200,6600400 701000,6600400 701000,6600200</gml:coordinates>
                    </gml:LinearRing>
                  </gml:outerBoundaryIs>
                </gml:Polygon>
                <gml:Polygon>
                  <gml:outerBoundaryIs>
                    <gml:LinearRing>
                      <gml:coordinates>701400,6600500 701500,6600500 701500,6600600 701400,6600600 701400,6600500</gml:coordinates>
                    </gml:LinearRing>
                  </gml:outerBoundaryIs>
                </gml:Polygon>
              </geometrie>
            </parcelle>
          </parcelles>
        </ilot>
      </ilots>
    </rpg>
  </producteur>
</producteurs>`;

describe('readTelepacMesParcellesXml', () => {
  it('parses parcelles into GeoJSON features', async () => {
    const collection = await telepacMesParcellesImporter.read(SAMPLE_XML);

    expect(collection.type).toBe('FeatureCollection');
    expect(collection.features).toHaveLength(2);

    const [first, second] = collection.features as TelepacFeature[];

    expect(first.geometry.type).toBe('Polygon');
    if (first.geometry.type === 'Polygon') {
      expect(first.geometry.coordinates).toHaveLength(2);
      const hole = first.geometry.coordinates[1];
      expect(hole.length).toBeGreaterThan(0);
    }

    expect(second.geometry.type).toBe('MultiPolygon');
    if (second.geometry.type === 'MultiPolygon') {
      expect(second.geometry.coordinates).toHaveLength(2);
    }

    collection.features.forEach((feature) => {
      const coordinates = feature.geometry.type === 'Polygon'
        ? feature.geometry.coordinates
        : feature.geometry.coordinates.flat();

      coordinates.forEach((ring) => {
        ring.forEach(([lon, lat]) => {
          expect(lon).toBeGreaterThan(-5);
          expect(lon).toBeLessThan(10);
          expect(lat).toBeGreaterThan(41);
          expect(lat).toBeLessThan(52);
        });
      });
    });

    expect(first.properties.production_semences).toBe(false);
    expect(first.properties.conduite_bio).toBe(false);
    expect(first.properties.isOrganic).toBe(false);
    expect(first.properties.organicType).toBe('AB');
    expect(first.properties.date_labour).toBeNull();
    expect(first.properties.code_culture).toBe('BTH');
    expect(first.properties.precision).toBe('001');
    expect(first.properties.culture_secondaire).toBe('A00');
    expect(first.properties.justification_motif).toBe('ILOT_M2');
    expect(first.properties.justification_texte).toContain('Justification fictive');

    expect(second.properties.production_semences).toBe(true);
    expect(second.properties.deshydratation).toBe(true);
    expect(second.properties.reconversion_pp).toBe(true);
    expect(second.properties.date_labour).toBe('20240112');
    expect(second.properties.precision).toBe('002');
    expect(second.properties.isOrganic).toBeUndefined();
    expect(second.properties.organicType).toBeUndefined();
  });

  it('accepts ArrayBuffer input', async () => {
    const buffer = new TextEncoder().encode(SAMPLE_XML).buffer;
    const collection = await telepacMesParcellesImporter.read(buffer);
    expect(collection.features).toHaveLength(2);
  });
});
