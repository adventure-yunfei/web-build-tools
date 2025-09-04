// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { ReleaseTag } from '@microsoft/api-extractor-model';
import type { Collector } from '../collector/Collector';
import type { CollectorEntity } from '../collector/CollectorEntity';
import type { AstEntity } from '../analyzer/AstEntity';
import { AstSymbol } from '../analyzer/AstSymbol';
import type { ApiItemMetadata } from '../collector/ApiItemMetadata';
import { AstNamespaceImport } from '../analyzer/AstNamespaceImport';
import type { IAstModuleExportInfo } from '../analyzer/AstModule';
import { AstImport } from '../analyzer/AstImport';
import { AstSubPathImport } from '../analyzer/AstSubPathImport';

export function getReleaseTagsToTrim(targetReleaseTag: ReleaseTag): Set<ReleaseTag> {
  return new Set(
    [ReleaseTag.Internal, ReleaseTag.Alpha, ReleaseTag.Beta, ReleaseTag.Public].filter(
      (tag) => ReleaseTag.compare(tag, targetReleaseTag) < 0
    )
  );
}

export function collectAllReferencedEntities(
  collector: Collector,
  /** specify a single release tag to emit, or a set of release tags to trim */
  releaseTagOrTrimming: ReleaseTag | ReadonlySet<ReleaseTag>,
  rootExportTrimmings: ReadonlySet<string>
): ReadonlySet<CollectorEntity> {
  const trimmedReleaseTags: ReadonlySet<ReleaseTag> =
    typeof releaseTagOrTrimming === 'number'
      ? getReleaseTagsToTrim(releaseTagOrTrimming)
      : releaseTagOrTrimming;

  const referencedAstEntities: Set<AstEntity> = new Set<AstEntity>();

  const alreadySeenAstEntities: Set<AstEntity> = new Set();
  function collectReferencesFromAstEntity(astEntity: AstEntity): void {
    if (alreadySeenAstEntities.has(astEntity)) {
      return;
    }
    alreadySeenAstEntities.add(astEntity);

    if (astEntity instanceof AstSymbol) {
      for (const astDeclaration of astEntity.astDeclarations) {
        const apiItemMetadata: ApiItemMetadata = collector.fetchApiItemMetadata(astDeclaration);
        const releaseTag: ReleaseTag = apiItemMetadata.effectiveReleaseTag;
        if (trimmedReleaseTags.has(releaseTag)) {
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

      const astModuleExport: IAstModuleExportInfo = astEntity.fetchAstModuleExportInfo(collector);
      for (const { astEntity: exportedLocalEntity } of astModuleExport.exportedLocalEntities.values()) {
        collectReferencesFromAstEntity(exportedLocalEntity);
      }
    } else if (astEntity instanceof AstImport) {
      referencedAstEntities.add(astEntity);
    } else if (astEntity instanceof AstSubPathImport) {
      referencedAstEntities.add(astEntity);

      collectReferencesFromAstEntity(astEntity.baseAstEntity);
    } else {
      throw new Error('Unknown AstEntity class: ' + astEntity.constructor.name);
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
