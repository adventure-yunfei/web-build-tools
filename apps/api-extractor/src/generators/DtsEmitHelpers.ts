// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as ts from 'typescript';

import { InternalError } from '@rushstack/node-core-library';
import { CollectorEntity } from '../collector/CollectorEntity';
import { AstImport, AstImportKind } from '../analyzer/AstImport';
import { StringWriter } from './StringWriter';
import { Collector } from '../collector/Collector';

/**
 * Some common code shared between DtsRollupGenerator and ApiReportGenerator.
 */
export class DtsEmitHelpers {
  public static emitImport(
    stringWriter: StringWriter,
    collector: Collector,
    collectorEntity: CollectorEntity,
    astImport: AstImport
  ): void {
    if (astImport.exportPath.length > 1) {
      const referencedAstImport: AstImport | undefined = collector.astSymbolTable.tryGetReferencedAstImport(
        astImport
      );
      if (referencedAstImport === undefined) {
        throw new Error(
          `For an AstImport of "EqualsImport" from namespace, there must have a referenced base AstImport.`
        );
      }
      const referencedCollectorEntity: CollectorEntity | undefined = collector.tryGetCollectorEntity(
        referencedAstImport
      );
      if (referencedCollectorEntity === undefined) {
        throw new Error(
          `Cannot find collector entity for referenced AstImport: ${referencedAstImport.modulePath}:${referencedAstImport.exportName}`
        );
      }
      stringWriter.writeLine(
        `import ${collectorEntity.nameForEmit} = ${
          referencedCollectorEntity.nameForEmit
        }.${astImport.exportPath.slice(1).join('.')};`
      );
      return;
    }

    const importPrefix: string = astImport.isTypeOnlyEverywhere ? 'import type' : 'import';

    switch (astImport.importKind) {
      case AstImportKind.DefaultImport:
        if (collectorEntity.nameForEmit !== astImport.exportName) {
          stringWriter.write(`${importPrefix} { default as ${collectorEntity.nameForEmit} }`);
        } else {
          stringWriter.write(`${importPrefix} ${astImport.exportName}`);
        }
        stringWriter.writeLine(` from '${astImport.modulePath}';`);
        break;
      case AstImportKind.NamedImport:
        if (collectorEntity.nameForEmit !== astImport.exportName) {
          stringWriter.write(`${importPrefix} { ${astImport.exportName} as ${collectorEntity.nameForEmit} }`);
        } else {
          stringWriter.write(`${importPrefix} { ${astImport.exportName} }`);
        }
        stringWriter.writeLine(` from '${astImport.modulePath}';`);
        break;
      case AstImportKind.StarImport:
        stringWriter.writeLine(
          `${importPrefix} * as ${collectorEntity.nameForEmit} from '${astImport.modulePath}';`
        );
        break;
      case AstImportKind.EqualsImport:
        stringWriter.writeLine(
          `${importPrefix} ${collectorEntity.nameForEmit} = require('${astImport.modulePath}');`
        );
        break;
      default:
        throw new InternalError('Unimplemented AstImportKind');
    }
  }

  public static emitNamedExport(
    stringWriter: StringWriter,
    exportName: string,
    collectorEntity: CollectorEntity
  ): void {
    if (exportName === ts.InternalSymbolName.Default) {
      stringWriter.writeLine(`export default ${collectorEntity.nameForEmit};`);
    } else if (collectorEntity.nameForEmit !== exportName) {
      stringWriter.writeLine(`export { ${collectorEntity.nameForEmit} as ${exportName} }`);
    } else {
      stringWriter.writeLine(`export { ${exportName} }`);
    }
  }

  public static emitStarExports(stringWriter: StringWriter, collector: Collector): void {
    if (collector.starExportedExternalModulePaths.length > 0) {
      stringWriter.writeLine();
      for (const starExportedExternalModulePath of collector.starExportedExternalModulePaths) {
        stringWriter.writeLine(`export * from "${starExportedExternalModulePath}";`);
      }
    }
  }
}
