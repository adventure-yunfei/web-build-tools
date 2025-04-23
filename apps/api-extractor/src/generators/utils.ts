import { ReleaseTag } from '@microsoft/api-extractor-model';
import type { Collector } from '../collector/Collector';
import type { CollectorEntity } from '../collector/CollectorEntity';
import type { AstEntity } from '../analyzer/AstEntity';
import { AstSymbol } from '../analyzer/AstSymbol';
import { ApiItemMetadata } from '../collector/ApiItemMetadata';
import { AstNamespaceImport } from '../analyzer/AstNamespaceImport';
import { AstModuleExportInfo } from '../analyzer/AstModule';

export function collectAllReferencedEntities(
  collector: Collector,
  releaseTimming: ReleaseTag,
  rootExportTrimmings: ReadonlySet<string>
): ReadonlySet<CollectorEntity> {
  const referencedAstEntities: Set<AstEntity> = new Set<AstEntity>();

  const alreadySeenAstEntities: Set<AstEntity> = new Set();
  function collectReferencesFromAstEntity(astEntity: AstEntity) {
    if (alreadySeenAstEntities.has(astEntity)) {
      return;
    }
    alreadySeenAstEntities.add(astEntity);

    if (astEntity instanceof AstSymbol) {
      for (const astDeclaration of astEntity.astDeclarations) {
        const apiItemMetadata: ApiItemMetadata = collector.fetchApiItemMetadata(astDeclaration);
        const releaseTag: ReleaseTag = apiItemMetadata.effectiveReleaseTag;
        if (releaseTag !== ReleaseTag.None && ReleaseTag.compare(releaseTag, releaseTimming) < 0) {
          continue; // trim out items under specified release tag
        }

        referencedAstEntities.add(astEntity);

        for (const referencedAstEntity of astDeclaration.referencedAstEntities) {
          collectReferencesFromAstEntity(referencedAstEntity);
        }
        for (const childDeclaration of astDeclaration.children) {
          collectReferencesFromAstEntity(childDeclaration.astSymbol);
        }
      }
    } else if (astEntity instanceof AstNamespaceImport) {
      referencedAstEntities.add(astEntity);

      const astModuleExport: AstModuleExportInfo = astEntity.fetchAstModuleExportInfo(collector);
      for (const { astEntity: exportedLocalEntity } of astModuleExport.exportedLocalEntities.values()) {
        collectReferencesFromAstEntity(exportedLocalEntity);
      }
    } else {
      referencedAstEntities.add(astEntity);
    }
  }

  for (const entity of collector.entities) {
    if (
      entity.exportedFromEntryPoint &&
      Array.from(entity.exportNames.keys()).some((name) => !rootExportTrimmings.has(name))
    ) {
      collectReferencesFromAstEntity(entity.astEntity);
    }
  }

  const referencedCollectorEntities: Set<CollectorEntity> = new Set();
  for (const referencedAstEntity of referencedAstEntities) {
    const referencedCollectorEntity: CollectorEntity | undefined =
      collector.tryGetCollectorEntity(referencedAstEntity);
    if (referencedCollectorEntity) {
      referencedCollectorEntities.add(referencedCollectorEntity);
    }
  }
  return referencedCollectorEntities;
}
