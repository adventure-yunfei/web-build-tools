// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import fs from 'fs';
import { patchFilePath } from './bulk-suppressions-patch';

/**
 * Dynamically generate file to properly patch many versions of ESLint
 * @param inputFilePath - Must be an iteration of https://github.com/eslint/eslint/blob/main/lib/linter/linter.js
 * @param outputFilePath - Some small changes to linter.js
 */
export function generatePatchedFileIfDoesNotExist(inputFilePath: string, outputFilePath: string): void {
  if (fs.existsSync(outputFilePath)) {
    return;
  }

  const inputFile: string = fs.readFileSync(inputFilePath).toString();

  let inputIndex: number = 0;

  /**
   * Extract from the stream until marker is reached.  When matching marker,
   * ignore whitespace in the stream and in the marker.  Return the extracted text.
   */
  function scanUntilMarker(marker: string): string {
    const trimmedMarker: string = marker.replace(/\s/g, '');

    let output: string = '';
    let trimmed: string = '';

    while (inputIndex < inputFile.length) {
      const char: string = inputFile[inputIndex++];
      output += char;
      if (!/^\s$/.test(char)) {
        trimmed += char;
      }
      if (trimmed.endsWith(trimmedMarker)) {
        return output;
      }
    }

    throw new Error('Unexpected end of input while looking for ' + JSON.stringify(marker));
  }

  function scanUntilNewline(): string {
    let output: string = '';

    while (inputIndex < inputFile.length) {
      const char: string = inputFile[inputIndex++];
      output += char;
      if (char === '\n') {
        return output;
      }
    }

    throw new Error('Unexpected end of input while looking for new line');
  }

  function scanUntilEnd(): string {
    const output: string = inputFile.substring(inputIndex);
    inputIndex = inputFile.length;
    return output;
  }

  /**
   * Returns index of next public method
   * @param fromIndex - index of inputFile to search if public method still exists
   * @returns -1 if public method does not exist or index of next public method
   */
  function getIndexOfNextPublicMethod(fromIndex: number): number {
    const rest: string = inputFile.substring(fromIndex);

    const endOfClassIndex: number = rest.indexOf('\n}');

    const markerForStartOfClassMethod: string = '\n     */\n    ';

    const startOfClassMethodIndex: number = rest.indexOf(markerForStartOfClassMethod);

    if (startOfClassMethodIndex === -1 || startOfClassMethodIndex > endOfClassIndex) {
      return -1;
    }

    const afterMarkerIndex: number =
      rest.indexOf(markerForStartOfClassMethod) + markerForStartOfClassMethod.length;

    const isPublicMethod: boolean =
      rest[afterMarkerIndex] !== '_' &&
      rest[afterMarkerIndex] !== '#' &&
      !rest.substring(afterMarkerIndex, rest.indexOf('\n', afterMarkerIndex)).includes('static') &&
      !rest.substring(afterMarkerIndex, rest.indexOf('\n', afterMarkerIndex)).includes('constructor');

    if (isPublicMethod) {
      return fromIndex + afterMarkerIndex;
    }

    return getIndexOfNextPublicMethod(fromIndex + afterMarkerIndex);
  }

  function scanUntilIndex(indexToScanTo: number): string {
    const output: string = inputFile.substring(inputIndex, indexToScanTo);
    inputIndex = indexToScanTo;
    return output;
  }

  let outputFile: string = '';

  // Match this:
  //    //------------------------------------------------------------------------------
  //    // Requirements
  //    //------------------------------------------------------------------------------
  outputFile += scanUntilMarker('// Requirements');
  outputFile += scanUntilMarker('//--');
  outputFile += scanUntilNewline();

  outputFile += `
// --- BEGIN MONKEY PATCH ---
const bulkSuppressionsPatch = require(${JSON.stringify(patchFilePath)});
const requireFromPathToLinterJS = bulkSuppressionsPatch.requireFromPathToLinterJS;
`;

  // Match this:
  //    //------------------------------------------------------------------------------
  //    // Typedefs
  //    //------------------------------------------------------------------------------
  const requireSection: string = scanUntilMarker('// Typedefs');

  // Match something like this:
  //
  //    const path = require('path'),
  //    eslintScope = require('eslint-scope'),
  //    evk = require('eslint-visitor-keys'),
  //
  // Convert to something like this:
  //
  //    const path = require('path'),
  //    eslintScope = requireFromPathToLinterJS('eslint-scope'),
  //    evk = requireFromPathToLinterJS('eslint-visitor-keys'),
  //
  outputFile += requireSection.replace(/require\s*\((?:'([^']+)'|"([^"]+)")\)/g, (match, p1, p2) => {
    const importPath: string = p1 ?? p2 ?? '';

    if (importPath !== 'path') {
      if (p1) {
        return `requireFromPathToLinterJS('${p1}')`;
      }
      if (p2) {
        return `requireFromPathToLinterJS("${p2}")`;
      }
    }

    // Keep as-is
    return match;
  });
  outputFile += `--- END MONKEY PATCH ---
`;

  // Match this:
  //    const ruleContext = Object.freeze(
  //      Object.assign(Object.create(sharedTraversalContext), {
  //        id: ruleId,
  //        options: getRuleOptions(configuredRules[ruleId]),
  //        report(...args) {
  //          /*
  //           * Create a report translator lazily.
  //
  // Convert to something like this:
  //
  //    const ruleContext = Object.freeze(
  //      Object.assign(Object.create(sharedTraversalContext), {
  //        id: ruleId,
  //        options: getRuleOptions(configuredRules[ruleId]),
  //        report(...args) {
  //          if (bulkSuppressionsPatch.shouldBulkSuppress({ filename, currentNode, ruleId })) return;
  //          /*
  //           * Create a report translator lazily.
  //
  outputFile += scanUntilMarker('const ruleContext = Object.freeze(');
  outputFile += scanUntilMarker('report(...args) {');
  outputFile += scanUntilNewline();
  outputFile += `
                        // --- BEGIN MONKEY PATCH ---
                        debugger;
                        if (bulkSuppressionsPatch.shouldBulkSuppress({ filename, currentNode, ruleId })) return;
                        // --- END MONKEY PATCH ---
`;

  // Match this:
  // nodeQueue.forEach((traversalInfo) => {
  //   currentNode = traversalInfo.node;
  //
  //   try {
  //     if (traversalInfo.isEntering) {
  //       eventGenerator.enterNode(currentNode);
  //     } else {
  //       eventGenerator.leaveNode(currentNode);
  //     }
  //   } catch (err) {
  //     err.currentNode = currentNode;
  //     throw err;
  //   }
  // });
  //
  // return lintingProblems;
  //
  // Convert to this:
  // nodeQueue.forEach((traversalInfo) => {
  //   currentNode = traversalInfo.node;
  //
  //   try {
  //     if (traversalInfo.isEntering) {
  //       eventGenerator.enterNode(currentNode);
  //     } else {
  //       eventGenerator.leaveNode(currentNode);
  //     }
  //   } catch (err) {
  //     err.currentNode = currentNode;
  //     throw err;
  //   }
  // });
  //
  // // --- BEGIN MONKEY PATCH ---
  // bulkSuppressionsPatch.onFinish({ filename });
  // // --- END MONKEY PATCH ---
  //
  // return lintingProblems;
  outputFile += scanUntilMarker('nodeQueue.forEach(traversalInfo => {');
  outputFile += scanUntilMarker('});');
  outputFile += scanUntilNewline();
  outputFile += `
    // --- BEGIN MONKEY PATCH ---
    bulkSuppressionsPatch.onFinish({ filename });
    // --- END MONKEY PATCH ---
`;

  outputFile += scanUntilMarker('class Linter {');
  outputFile += scanUntilNewline();
  outputFile += `
    // --- BEGIN MONKEY PATCH ---
    /**
     * We intercept ESLint execution at the .eslintrc.js file, but unfortunately the Linter class is
     * initialized before the .eslintrc.js file is executed. This means the internalSlotsMap that all
     * the patched methods refer to is not initialized. This method checks if the internalSlotsMap is
     * initialized, and if not, initializes it.
     */
    _conditionallyReinitialize({ cwd, configType } = {}) {
        if (internalSlotsMap.get(this) === undefined) {
            internalSlotsMap.set(this, {
              cwd: normalizeCwd(cwd),
              lastConfigArray: null,
              lastSourceCode: null,
              lastSuppressedMessages: [],
              configType, // TODO: Remove after flat config conversion
              parserMap: new Map([['espree', espree]]),
              ruleMap: new Rules()
            });

            this.version = pkg.version;
        }
    }
    // --- END MONKEY PATCH ---
`;

  let indexOfNextPublicMethod: number = getIndexOfNextPublicMethod(inputIndex);
  while (indexOfNextPublicMethod !== -1) {
    outputFile += scanUntilIndex(indexOfNextPublicMethod);
    outputFile += scanUntilNewline();
    outputFile += `        // --- BEGIN MONKEY PATCH ---
        this._conditionallyReinitialize();
        // --- END MONKEY PATCH ---
`;
    indexOfNextPublicMethod = getIndexOfNextPublicMethod(inputIndex);
  }

  outputFile += scanUntilEnd();

  fs.writeFileSync(outputFilePath, outputFile);
}
