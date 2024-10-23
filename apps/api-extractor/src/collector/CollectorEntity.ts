// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as ts from 'typescript';

import { AstSymbol } from '../analyzer/AstSymbol';
import { Collector } from './Collector';
import { Sort } from '@rushstack/node-core-library';
import type { AstEntity } from '../analyzer/AstEntity';

/**
 * This is a data structure used by the Collector to track an AstEntity that may be emitted in the *.d.ts file.
 *
 * @remarks
 * The additional contextual state beyond AstSymbol is:
 * - Whether it's an export of this entry point or not
 * - The nameForEmit, which may get renamed by DtsRollupGenerator._makeUniqueNames()
 * - The export name (or names, if the same symbol is exported multiple times)
 */
export class CollectorEntity {
  /**
   * The AstEntity that this entry represents.
   */
  public readonly astEntity: AstEntity;

  private _exportNames: Map<string, { isTypeOnlyExport: boolean }> = new Map();
  private _exportNamesSorted: boolean = false;
  private _singleExportName: string | undefined = undefined;
  private _localExportNamesByParent: Map<CollectorEntity, Map<string, { isTypeOnlyExport: boolean }>> =
    new Map();

  private _nameForEmit: string | undefined = undefined;

  private _sortKey: string | undefined = undefined;

  public constructor(astEntity: AstEntity) {
    this.astEntity = astEntity;
  }

  /**
   * The declaration name that will be emitted in the .d.ts rollup, .api.md, and .api.json files. Generated by
   * `Collector._makeUniqueNames`. Be aware that the declaration may be renamed to avoid conflicts with (1)
   * global names (e.g. `Promise`) and (2) if local, other local names across different files.
   */
  public get nameForEmit(): string | undefined {
    return this._nameForEmit;
  }

  public set nameForEmit(value: string | undefined) {
    this._nameForEmit = value;
    this._sortKey = undefined; // invalidate the cached value
  }

  /**
   * The list of export names if this symbol is exported from the entry point.
   *
   * @remarks
   * Note that a given symbol may be exported more than once:
   * ```
   * class X { }
   * export { X }
   * export { X as Y }
   * ```
   */
  public get exportNames(): ReadonlyMap<string, { isTypeOnlyExport: boolean }> {
    if (!this._exportNamesSorted) {
      Sort.sortMapKeys(this._exportNames);
      this._exportNamesSorted = true;
    }
    return this._exportNames;
  }

  /**
   * If exportNames contains only one string, then singleExportName is that string.
   * In all other cases, it is undefined.
   */
  public get singleExportName(): string | undefined {
    return this._singleExportName;
  }

  /**
   * This is true if exportNames contains only one string, and the declaration can be exported using the inline syntax
   * such as "export class X { }" instead of "export { X }".
   */
  public get shouldInlineExport(): boolean {
    // We don't inline an AstImport
    if (this.astEntity instanceof AstSymbol) {
      // We don't inline a symbol with more than one exported name
      if (this._singleExportName !== undefined && this._singleExportName !== ts.InternalSymbolName.Default) {
        // We can't inline a type-only export
        if (this._exportNames.get(this._singleExportName)?.isTypeOnlyExport) {
          return false;
        }
        // We can't inline a symbol whose emitted name is different from the export name
        if (this._nameForEmit === undefined || this._nameForEmit === this._singleExportName) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Indicates that this entity is exported from the package entry point. Compare to `CollectorEntity.exported`.
   */
  public get exportedFromEntryPoint(): boolean {
    return this.exportNames.size > 0;
  }

  /**
   * Indicates that this entity is exported from its parent module (i.e. either the package entry point or
   * a local namespace). Compare to `CollectorEntity.consumable`.
   *
   * @remarks
   * In the example below:
   *
   * ```ts
   * declare function add(): void;
   * declare namespace calculator {
   *  export {
   *    add
   *  }
   * }
   * ```
   *
   * Namespace `calculator` is neither exported nor consumable, function `add` is exported (from `calculator`)
   * but not consumable.
   */
  public get exported(): boolean {
    // Exported from top-level?
    if (this.exportedFromEntryPoint) return true;

    // Exported from parent?
    for (const localExportNames of this._localExportNamesByParent.values()) {
      if (localExportNames.size > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Indicates that it is possible for a consumer of the API to "consume" this entity, either by importing
   * it directly or via a namespace. If an entity is not consumable, then API Extractor will report an
   * `ae-forgotten-export` warning. Compare to `CollectorEntity.exported`.
   *
   * @remarks
   * An API item is consumable if:
   *
   * 1. It is exported from the top-level entry point OR
   * 2. It is exported from a consumable parent entity.
   *
   * For an example of #2, consider how `AstNamespaceImport` entities are processed. A generated rollup.d.ts
   * might look like this:
   *
   * ```ts
   * declare function add(): void;
   * declare namespace calculator {
   *   export {
   *     add
   *   }
   * }
   * export { calculator }
   * ```
   *
   * In this example, `add` is exported via the consumable `calculator` namespace.
   */
  public get consumable(): boolean {
    // Exported from top-level?
    if (this.exportedFromEntryPoint) return true;

    // Exported from consumable parent?
    for (const [parent, localExportNames] of this._localExportNamesByParent) {
      if (localExportNames.size > 0 && parent.consumable) {
        return true;
      }
    }

    return false;
  }

  /**
   * Return the first consumable parent that exports this entity. If there is none, returns
   * `undefined`.
   */
  public getFirstExportingConsumableParent(): CollectorEntity | undefined {
    for (const [parent, localExportNames] of this._localExportNamesByParent) {
      if (parent.consumable && localExportNames.size > 0) {
        return parent;
      }
    }
    return undefined;
  }

  /**
   * Adds a new export name to the entity.
   */
  public addExportName(exportName: string, isTypeOnlyExport: boolean): void {
    if (!this._exportNames.has(exportName)) {
      this._exportNamesSorted = false;
      this._exportNames.set(exportName, { isTypeOnlyExport });

      if (this._exportNames.size === 1) {
        this._singleExportName = exportName;
      } else {
        this._singleExportName = undefined;
      }
    }
  }

  /**
   * Adds a new local export name to the entity.
   *
   * @remarks
   * In the example below:
   *
   * ```ts
   * declare function add(): void;
   * declare namespace calculator {
   *  export {
   *    add
   *  }
   * }
   * ```
   *
   * `add` is the local export name for the `CollectorEntity` for `add`.
   */
  public addLocalExportName(
    localExportName: string,
    isTypeOnlyExport: boolean,
    parent: CollectorEntity
  ): void {
    const localExportNames: Map<string, { isTypeOnlyExport: boolean }> =
      this._localExportNamesByParent.get(parent) || new Map();
    localExportNames.set(localExportName, { isTypeOnlyExport });

    this._localExportNamesByParent.set(parent, localExportNames);
  }

  /**
   * A sorting key used by DtsRollupGenerator._makeUniqueNames()
   */
  public getSortKey(): string {
    if (!this._sortKey) {
      this._sortKey = Collector.getSortKeyIgnoringUnderscore(this.nameForEmit || this.astEntity.localName);
    }
    return this._sortKey;
  }
}
