// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import {
  Colors,
  JsonFile,
  FileSystemStats,
  IFileSystemCreateLinkOptions,
  IColorableSequence,
  Terminal,
  ITerminalProvider
} from '@rushstack/node-core-library';
import * as crypto from 'crypto';
import { Tslint as TTslint, Typescript as TTypescript } from '@microsoft/rush-stack-compiler-3.7';
import {
  ExtendedTypeScript,
  IEmitResolver,
  IExtendedEmitResult,
  IEmitHost,
  IEmitTransformers,
  IExtendedProgram,
  IExtendedSourceFile,
  IResolveModuleNameResolutionHost
} from './internalTypings/TypeScriptInternals';

import { SubprocessRunnerBase } from '../../utilities/subprocess/SubprocessRunnerBase';
import { Async } from '../../utilities/Async';
import { ResolveUtilities } from '../../utilities/ResolveUtilities';
import { IExtendedLinter } from './internalTypings/TslintInternals';
import { IEmitModuleKindBase, ISharedTypeScriptConfiguration } from '../../cli/actions/BuildAction';
import { PerformanceMeasurer, PerformanceMeasurerAsync } from '../../utilities/Performance';
import { PrefixProxyTerminalProvider } from '../../utilities/PrefixProxyTerminalProvider';

export interface ITypeScriptBuilderConfiguration extends ISharedTypeScriptConfiguration {
  buildFolder: string;
  typeScriptToolPath: string;
  tslintToolPath: string;
  eslintToolPath: string;

  /**
   * If provided, this is included in the logging prefix. For example, if this
   * is set to "other-tsconfig", logging lines will start with [typescript (other-tsconfig)].
   */
  terminalPrefixLabel: string | undefined;

  lintingEnabled: boolean;

  watchMode: boolean;

  /**
   * The path to the tsconfig file being built.
   */
  tsconfigPath: string;

  /**
   * The path of project's build cache folder
   */
  buildCacheFolder: string;

  /**
   * The maximum number of simultaneous filesystem writes allowed.
   */
  maxWriteParallelism: number;
}

interface ICachedEmitModuleKind<TModuleKind> extends IEmitModuleKindBase<TModuleKind> {
  /**
   * TypeScript's output is placed in the \<project root\>/.heft/build-cache folder.
   * This is the the path to the subfolder in the build-cache folder that this emit kind
   * written to.
   */
  cacheOutFolderPath: string;

  /**
   * Set to true if this is the emit kind that is specified in the tsconfig.json.
   * Sourcemaps and declarations are only emitted for the primary module kind.
   */
  isPrimary: boolean;
}

interface IFileToWrite {
  filePath: string;
  data: string;
}

interface ITsLintCacheData {
  /**
   * The TSLint version and a hash of the TSLint config files. If either changes,
   * the cache is invalidated.
   */
  cacheVersion: string;

  /**
   * This is the result of `Array.from(Map<string, string>)`. The first element of
   * each array item is the file's path and the second element is the file's hash.
   */
  fileVersions: [string, string][];
}

interface IRunTslintOptions {
  tslint: typeof TTslint;
  tsProgram: IExtendedProgram;

  /**
   * All of the files that the TypeScript compiler processed.
   */
  typeScriptFilenames: Set<string>;

  /**
   * A performance measurer for the TSLint run.
   */
  measurePerformance: PerformanceMeasurer;

  /**
   * The set of files that TypeScript has compiled since the last compilation.
   */
  changedFiles: Set<IExtendedSourceFile>;
}

type TWatchCompilerHost = TTypescript.WatchCompilerHostOfFilesAndCompilerOptions<
  TTypescript.EmitAndSemanticDiagnosticsBuilderProgram
>;

const EMPTY_JSON: object = {};

export class TypeScriptBuilder extends SubprocessRunnerBase<ITypeScriptBuilderConfiguration> {
  private _lintingEnabled: boolean;
  private _moduleKindsToEmit: ICachedEmitModuleKind<TTypescript.ModuleKind>[];
  private _rawProjectTslintFile: string | undefined;
  private _tslintConfigFilePath: string;
  private _typescriptTerminal: Terminal;
  private _tslintTerminal: Terminal;

  private __tsCacheFilePath: string | undefined;
  private __tslintCacheFilePath: string | undefined;
  private _tsReadJsonCache: Map<string, object> = new Map<string, object>();

  public get filename(): string {
    return __filename;
  }

  private get _tsCacheFilePath(): string {
    if (!this.__tsCacheFilePath) {
      const configHash: crypto.Hash = this._getConfigHash(
        this._configuration.tsconfigPath,
        this._typescriptTerminal
      );
      configHash.update(JSON.stringify(this._configuration.additionalModuleKindsToEmit));
      const serializedConfigHash: string = configHash.digest('hex');

      this.__tsCacheFilePath = path.posix.join(
        this._configuration.buildCacheFolder,
        `ts_${serializedConfigHash}.json`
      );
    }

    return this.__tsCacheFilePath;
  }

  private get _tslintCacheFilePath(): string {
    if (!this.__tslintCacheFilePath) {
      this.__tslintCacheFilePath = path.posix.join(this._configuration.buildCacheFolder, 'tslint.json');
    }

    return this.__tslintCacheFilePath;
  }

  public static getTypeScriptTerminal(
    terminalProvider: ITerminalProvider,
    prefixLabel: string | undefined
  ): Terminal {
    return TypeScriptBuilder._getTerminal(terminalProvider, 'typescript', prefixLabel);
  }

  public static getTslintTerminal(
    terminalProvider: ITerminalProvider,
    prefixLabel: string | undefined
  ): Terminal {
    return TypeScriptBuilder._getTerminal(terminalProvider, 'tslint', prefixLabel);
  }

  private static _getTerminal(
    terminalProvider: ITerminalProvider,
    prefixName: string,
    prefixLabel: string | undefined
  ): Terminal {
    const prefixTerminalProvider: PrefixProxyTerminalProvider = new PrefixProxyTerminalProvider(
      terminalProvider,
      prefixLabel ? `[${prefixName} (${prefixLabel})] ` : `[${prefixName}] `
    );

    return new Terminal(prefixTerminalProvider);
  }

  public initializeTerminal(terminalProvider: ITerminalProvider): void {
    this._typescriptTerminal = TypeScriptBuilder.getTypeScriptTerminal(
      terminalProvider,
      this._configuration.terminalPrefixLabel
    );
    this._tslintTerminal = TypeScriptBuilder.getTslintTerminal(
      terminalProvider,
      this._configuration.terminalPrefixLabel
    );
  }

  public initialize(): void {
    this._configuration.buildCacheFolder = this._configuration.buildCacheFolder.replace(/\\/g, '/');
    this._tslintConfigFilePath = path.resolve(this._configuration.buildFolder, 'tslint.json');
    this._lintingEnabled = this._configuration.lintingEnabled && !this._configuration.watchMode; // Don't run lint in watch mode

    if (this._lintingEnabled) {
      try {
        this._rawProjectTslintFile = this._fileSystem.readFile(this._tslintConfigFilePath);
      } catch (e) {
        if (this._fileSystem.isNotExistError(e)) {
          this._rawProjectTslintFile = undefined;
          // The TSLint config file doesn't exist - so just disable linting
          this._lintingEnabled = false;
        } else {
          throw e;
        }
      }
    }
  }

  public async invokeAsync(): Promise<void> {
    const ts: ExtendedTypeScript = require(this._configuration.typeScriptToolPath);

    const tslint: typeof TTslint | undefined = this._lintingEnabled
      ? require(this._configuration.tslintToolPath)
      : undefined;

    this._typescriptTerminal.writeLine(`Using TypeScript version ${ts.version}`);
    if (tslint) {
      this._tslintTerminal.writeLine(`Using TSLint version ${tslint.Linter.VERSION}`);
    }

    ts.performance.enable();

    const measureTsPerformance: PerformanceMeasurer = <TResult extends object | void>(
      measurementName: string,
      fn: () => TResult
    ) => {
      const beforeName: string = `before${measurementName}`;
      ts.performance.mark(beforeName);
      const result: TResult = fn();
      const afterName: string = `after${measurementName}`;
      ts.performance.mark(afterName);
      ts.performance.measure(measurementName, beforeName, afterName);
      return {
        ...result,
        duration: ts.performance.getDuration(measurementName),
        count: ts.performance.getCount(beforeName)
      };
    };

    const measureTsPerformanceAsync: PerformanceMeasurerAsync = async <TResult extends object | void>(
      measurementName: string,
      fn: () => Promise<TResult>
    ) => {
      const beforeName: string = `before${measurementName}`;
      ts.performance.mark(beforeName);
      const resultPromise: Promise<TResult> = fn();
      const result: TResult = await resultPromise;
      const afterName: string = `after${measurementName}`;
      ts.performance.mark(afterName);
      ts.performance.measure(measurementName, beforeName, afterName);
      return {
        ...result,
        duration: ts.performance.getDuration(measurementName)
      };
    };

    if (this._configuration.watchMode) {
      await this._runWatch(ts, measureTsPerformance);
    } else {
      await this._runBuild(ts, tslint, measureTsPerformance, measureTsPerformanceAsync);
    }
  }

  public async _runWatch(ts: ExtendedTypeScript, measureTsPerformance: PerformanceMeasurer): Promise<void> {
    //#region CONFIGURE
    const { duration: configureDurationMs, tsconfig, compilerHost } = measureTsPerformance(
      'Configure',
      () => {
        const _tsconfig: TTypescript.ParsedCommandLine = this._loadTsconfig(ts);
        const _compilerHost: TWatchCompilerHost = this._buildWatchCompilerHost(ts, _tsconfig);
        return {
          tsconfig: _tsconfig,
          compilerHost: _compilerHost
        };
      }
    );
    this._typescriptTerminal.writeVerboseLine(`Configure: ${configureDurationMs}ms`);
    //#endregion

    this._validateTsconfig(ts, tsconfig);

    ts.createWatchProgram(compilerHost);

    return new Promise(() => {
      /* never terminate */
    });
  }

  public async _runBuild(
    ts: ExtendedTypeScript,
    tslint: typeof TTslint | undefined,
    measureTsPerformance: PerformanceMeasurer,
    measureTsPerformanceAsync: PerformanceMeasurerAsync
  ): Promise<void> {
    // Ensure the cache folder exists
    this._fileSystem.ensureFolder(this._configuration.buildCacheFolder);

    //#region CONFIGURE
    const { duration: configureDurationMs, tsconfig, compilerHost } = measureTsPerformance(
      'Configure',
      () => {
        this._overrideTypeScriptReadJson(ts);
        const _tsconfig: TTypescript.ParsedCommandLine = this._loadTsconfig(ts);
        const _compilerHost: TTypescript.CompilerHost = this._buildIncrementalCompilerHost(ts, _tsconfig);
        return {
          tsconfig: _tsconfig,
          compilerHost: _compilerHost
        };
      }
    );
    this._typescriptTerminal.writeVerboseLine(`Configure: ${configureDurationMs}ms`);
    //#endregion

    this._validateTsconfig(ts, tsconfig);

    //#region PROGRAM
    // There will be only one program here; emit will get a bit abused if we produce multiple outputs
    const tsProgram: TTypescript.BuilderProgram = ts.createIncrementalProgram({
      rootNames: tsconfig.fileNames,
      options: tsconfig.options,
      projectReferences: tsconfig.projectReferences,
      host: compilerHost,
      configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(tsconfig)
    });

    this._typescriptTerminal.writeVerboseLine(
      `I/O Read: ${ts.performance.getDuration('I/O Read')}ms (${ts.performance.getCount(
        'beforeIORead'
      )} files)`
    );
    this._typescriptTerminal.writeVerboseLine(
      `Parse: ${ts.performance.getDuration('Parse')}ms (${ts.performance.getCount('beforeParse')} files)`
    );
    this._typescriptTerminal.writeVerboseLine(
      `Program (includes Read + Parse): ${ts.performance.getDuration('Program')}ms`
    );
    //#endregion

    //#region DIAGNOSTICS
    const { duration: diagnosticsDurationMs, diagnostics } = measureTsPerformance('Diagnostics', () => {
      const rawDiagnostics: TTypescript.Diagnostic[] = [
        ...tsProgram.getConfigFileParsingDiagnostics(),
        ...tsProgram.getOptionsDiagnostics(),
        ...tsProgram.getSyntacticDiagnostics(),
        ...tsProgram.getGlobalDiagnostics(),
        ...tsProgram.getSemanticDiagnostics()
      ];
      const _diagnostics: ReadonlyArray<TTypescript.Diagnostic> = ts.sortAndDeduplicateDiagnostics(
        rawDiagnostics
      );
      return { diagnostics: _diagnostics };
    });
    this._typescriptTerminal.writeVerboseLine(`Diagnostics: ${diagnosticsDurationMs}ms`);
    //#endregion

    //#region EMIT
    const filesToWrite: IFileToWrite[] = [];
    const writeFileCallback: TTypescript.WriteFileCallback = (filePath: string, data: string) => {
      filesToWrite.push({ filePath, data });
    };

    const emitResult: IExtendedEmitResult = this._emit(ts, tsconfig, tsProgram, writeFileCallback);
    //#endregion

    this._typescriptTerminal.writeVerboseLine(`Bind: ${ts.performance.getDuration('Bind')}ms`);
    this._typescriptTerminal.writeVerboseLine(`Check: ${ts.performance.getDuration('Check')}ms`);
    this._typescriptTerminal.writeVerboseLine(
      `Transform: ${ts.performance.getDuration('transformTime')}ms ` +
        `(${ts.performance.getCount('beforeTransform')} files)`
    );
    this._typescriptTerminal.writeVerboseLine(
      `Print: ${ts.performance.getDuration('printTime')}ms ` +
        `(${ts.performance.getCount('beforePrint')} files) (Includes Transform)`
    );
    this._typescriptTerminal.writeVerboseLine(
      `Emit: ${ts.performance.getDuration('Emit')}ms (Includes Print)`
    );

    //#region WRITE
    const writePromise: Promise<{ duration: number }> = measureTsPerformanceAsync('Write', () =>
      Async.forEachLimitAsync(
        filesToWrite,
        this._configuration.maxWriteParallelism,
        async ({ filePath, data }) => this._fileSystem.writeFile(filePath, data, { ensureFolderExists: true })
      )
    );
    //#endregion

    const typeScriptFilenames: Set<string> = new Set(tsconfig.fileNames);

    //#region TSLINT
    let tslintResult: TTslint.LintResult | undefined = undefined;
    if (tslint) {
      tslintResult = await this._runTslintAsync({
        tslint,
        tsProgram: tsProgram.getProgram() as IExtendedProgram,
        typeScriptFilenames: typeScriptFilenames,
        measurePerformance: measureTsPerformance,
        changedFiles: emitResult.changedSourceFiles
      });

      this._tslintTerminal.writeVerboseLine(
        `Lint: ${ts.performance.getDuration('Lint')}ms (${ts.performance.getCount('beforeLint')} files)`
      );
    }
    //#endregion

    const { duration: writeDuration } = await writePromise;
    this._typescriptTerminal.writeVerboseLine(`I/O Write: ${writeDuration}ms (${filesToWrite.length} files)`);

    //#region HARDLINK/COPY
    const shouldHardlink: boolean = this._configuration.copyFromCacheMode !== 'copy';
    const { duration: hardlinkDuration, linkCount: hardlinkCount } = await measureTsPerformanceAsync(
      shouldHardlink ? 'Hardlink' : 'CopyFromCache',
      async () => {
        const commonSourceDirectory: string = (tsProgram.getProgram() as IExtendedProgram).getCommonSourceDirectory();
        const linkPromises: Promise<void>[] = [];
        let linkCount: number = 0;

        const resolverHost: IResolveModuleNameResolutionHost = {
          getCurrentDirectory: () => compilerHost.getCurrentDirectory(),
          getCommonSourceDirectory: () => commonSourceDirectory,
          getCanonicalFileName: (filename: string) => compilerHost.getCanonicalFileName(filename)
        };

        let queueLinkOrCopy: (options: IFileSystemCreateLinkOptions) => void;
        if (shouldHardlink) {
          queueLinkOrCopy = (options: IFileSystemCreateLinkOptions) => {
            linkPromises.push(
              this._fileSystem
                .createHardLinkExtendedAsync({ ...options, preserveExisting: true })
                .then((successful) => {
                  if (successful) {
                    linkCount++;
                  }
                })
                .catch((error) => {
                  if (!this._fileSystem.isNotExistError(error)) {
                    // Only re-throw errors that aren't not-exist errors
                    throw error;
                  }
                })
            );
          };
        } else {
          queueLinkOrCopy = (options: IFileSystemCreateLinkOptions) => {
            linkPromises.push(
              this._fileSystem
                .copyFileAsync({
                  sourcePath: options.linkTargetPath,
                  destinationPath: options.newLinkPath
                })
                .then(() => {
                  linkCount++;
                })
                .catch((error) => {
                  if (!this._fileSystem.isNotExistError(error)) {
                    // Only re-throw errors that aren't not-exist errors
                    throw error;
                  }
                })
            );
          };
        }

        for (const sourceFile of tsProgram.getSourceFiles()) {
          const filename: string = sourceFile.fileName;
          if (typeScriptFilenames.has(filename)) {
            const relativeFilenameWithoutExtension: string = ts.removeFileExtension(
              ts.getExternalModuleNameFromPath(resolverHost, filename)
            );

            for (const { cacheOutFolderPath, outFolderPath, isPrimary } of this._moduleKindsToEmit) {
              if (isPrimary) {
                // Only primary module kinds emit declarations and sourcemaps
                if (tsconfig.options.declaration) {
                  const dtsFilename: string = `${relativeFilenameWithoutExtension}.d.ts`;
                  queueLinkOrCopy({
                    linkTargetPath: path.join(cacheOutFolderPath, dtsFilename),
                    newLinkPath: path.join(outFolderPath, dtsFilename)
                  });
                }

                if (tsconfig.options.sourceMap && !sourceFile.isDeclarationFile) {
                  const jsMapFilename: string = `${relativeFilenameWithoutExtension}.js.map`;
                  queueLinkOrCopy({
                    linkTargetPath: path.join(cacheOutFolderPath, jsMapFilename),
                    newLinkPath: path.join(outFolderPath, jsMapFilename)
                  });
                }

                if (tsconfig.options.declarationMap) {
                  const dtsMapFilename: string = `${relativeFilenameWithoutExtension}.d.ts.map`;
                  queueLinkOrCopy({
                    linkTargetPath: path.join(cacheOutFolderPath, dtsMapFilename),
                    newLinkPath: path.join(outFolderPath, dtsMapFilename)
                  });
                }
              }

              if (!sourceFile.isDeclarationFile) {
                const jsFilename: string = `${relativeFilenameWithoutExtension}.js`;
                queueLinkOrCopy({
                  linkTargetPath: path.join(cacheOutFolderPath, jsFilename),
                  newLinkPath: path.join(outFolderPath, jsFilename)
                });
              }
            }
          }
        }

        await Promise.all(linkPromises);

        return { linkCount };
      }
    );

    this._typescriptTerminal.writeVerboseLine(
      `${shouldHardlink ? 'Hardlink' : 'Copy from cache'}: ${hardlinkDuration}ms (${hardlinkCount} files)`
    );
    //#endregion

    let compilationFailed: boolean = false;
    if (diagnostics.length > 0) {
      this._typescriptTerminal.writeErrorLine(
        `Encountered ${diagnostics.length} TypeScript error${diagnostics.length > 1 ? 's' : ''}:`
      );
      for (const diagnostic of diagnostics) {
        this._printDiagnosticMessage(ts, diagnostic, true);
      }

      compilationFailed = true;
    }

    if (tslintResult?.failures?.length) {
      this._tslintTerminal.writeWarningLine(
        `Encountered ${tslintResult!.failures.length} TSLint error${
          tslintResult!.failures.length > 1 ? 's' : ''
        }:`
      );
      for (const tslintFailure of tslintResult!.failures) {
        const buildFolderRelativeFilename: string = path.relative(
          this._configuration.buildFolder,
          tslintFailure.getFileName()
        );
        const { line, character } = tslintFailure.getStartPosition().getLineAndCharacter();
        const severity: string = tslintFailure.getRuleSeverity().toUpperCase();
        this._tslintTerminal.writeWarningLine(
          '  ',
          Colors.yellow(`${severity}: ${buildFolderRelativeFilename}:${line + 1}:${character + 1}`),
          ' - ',
          Colors.yellow(`(${tslintFailure.getRuleName()}) ${tslintFailure.getFailure()}`)
        );
      }
    }

    if (compilationFailed) {
      throw new Error('TypeScript compilation failed.');
    }
  }

  private _printDiagnosticMessage(
    ts: ExtendedTypeScript,
    diagnostic: TTypescript.Diagnostic,
    withIndent: boolean = false
  ): void {
    let terminalMessage: (string | IColorableSequence)[];
    // Code taken from reference example
    if (diagnostic.file) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
      const message: string = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      const buildFolderRelativeFilename: string = path.relative(
        this._configuration.buildFolder,
        diagnostic.file.fileName
      );
      terminalMessage = [
        Colors.red(`ERROR: ${buildFolderRelativeFilename}:${line + 1}:${character + 1}`),
        ` - (TS${diagnostic.code}) `,
        Colors.red(message)
      ];
    } else {
      terminalMessage = [ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')];
    }

    if (withIndent) {
      terminalMessage = ['  ', ...terminalMessage];
    }

    switch (diagnostic.category) {
      case ts.DiagnosticCategory.Error: {
        this._typescriptTerminal.writeErrorLine(...terminalMessage);
        break;
      }

      case ts.DiagnosticCategory.Warning: {
        this._typescriptTerminal.writeWarningLine(...terminalMessage);
        break;
      }

      default: {
        this._typescriptTerminal.writeLine(...terminalMessage);
        break;
      }
    }
  }

  private _emit(
    ts: ExtendedTypeScript,
    tsconfig: TTypescript.ParsedCommandLine,
    tsProgram: TTypescript.BuilderProgram,
    writeFile: TTypescript.WriteFileCallback
  ): IExtendedEmitResult {
    let foundPrimary: boolean = false;
    const moduleKindCompilerOptions: Map<TTypescript.ModuleKind, TTypescript.CompilerOptions> = new Map();
    let defaultModuleKind: TTypescript.ModuleKind;
    for (const { moduleKind, cacheOutFolderPath, isPrimary } of this._moduleKindsToEmit) {
      if (isPrimary) {
        if (foundPrimary) {
          throw new Error('Multiple primary module emit kinds encountered.');
        } else {
          foundPrimary = true;
        }

        moduleKindCompilerOptions.set(moduleKind, {
          ...tsconfig.options,
          outDir: cacheOutFolderPath
        });
        defaultModuleKind = moduleKind;
      } else {
        moduleKindCompilerOptions.set(moduleKind, {
          ...tsconfig.options,
          outDir: cacheOutFolderPath,
          module: moduleKind,

          // Don't emit declarations or sourcemaps for secondary module kinds
          declaration: false,
          sourceMap: false,
          declarationMap: false
        });
      }
    }

    const baseEmitFiles: typeof ts.emitFiles = ts.emitFiles;

    const changedFiles: Set<IExtendedSourceFile> = new Set<IExtendedSourceFile>();
    // Override the underlying file emitter to run itself once for each flavor
    // This is a rather inelegant way to convince the TypeScript compiler not to duplicate parse/link/check
    ts.emitFiles = (
      resolver: IEmitResolver,
      host: IEmitHost,
      targetSourceFile: IExtendedSourceFile | undefined,
      emitTransformers: IEmitTransformers,
      emitOnlyDtsFiles?: boolean,
      onlyBuildInfo?: boolean,
      forceDtsEmit?: boolean
    ): TTypescript.EmitResult => {
      if (onlyBuildInfo || emitOnlyDtsFiles) {
        // There should only be one tsBuildInfo and one set of declaration files
        return baseEmitFiles(
          resolver,
          host,
          targetSourceFile,
          emitTransformers,
          emitOnlyDtsFiles,
          onlyBuildInfo,
          forceDtsEmit
        );
      } else {
        if (targetSourceFile) {
          changedFiles.add(targetSourceFile);
        }

        let defaultModuleKindResult: TTypescript.EmitResult;
        let emitSkipped: boolean = false;
        for (const [moduleKind, compilerOptions] of moduleKindCompilerOptions.entries()) {
          const flavorResult: TTypescript.EmitResult = baseEmitFiles(
            resolver,
            {
              ...host,
              getCompilerOptions: () => compilerOptions
            },
            targetSourceFile,
            ts.getTransformers(compilerOptions, undefined, emitOnlyDtsFiles),
            emitOnlyDtsFiles,
            onlyBuildInfo,
            forceDtsEmit
          );

          emitSkipped = emitSkipped || flavorResult.emitSkipped;
          if (moduleKind === defaultModuleKind) {
            defaultModuleKindResult = flavorResult;
          }
          // Should results be aggregated, in case for whatever reason the diagnostics are not the same?
        }
        return {
          ...defaultModuleKindResult!,
          emitSkipped
        };
      }
    };

    const result: TTypescript.EmitResult = tsProgram.emit(
      undefined, // Target source file
      writeFile
    );

    ts.emitFiles = baseEmitFiles;

    return {
      ...result,
      changedSourceFiles: changedFiles
    };
  }

  private _validateTsconfig(ts: ExtendedTypeScript, tsconfig: TTypescript.ParsedCommandLine): void {
    if (
      (tsconfig.options.module && !tsconfig.options.outDir) ||
      (!tsconfig.options.module && tsconfig.options.outDir)
    ) {
      throw new Error(
        'If either the module or the outDir option is provided in the tsconfig compilerOptions, both must be provided'
      );
    }

    this._moduleKindsToEmit = [];

    let tsconfigOutFolderName: string;
    if (!tsconfig.options.module) {
      throw new Error(
        'If the module tsconfig compilerOption is not provided, the builder must be provided with the ' +
          'additionalModuleKindsToEmit configuration option.'
      );
    } else {
      tsconfigOutFolderName = this._addModuleKindToEmit(
        tsconfig.options.module,
        tsconfig.options.outDir!,
        true
      );
    }

    if (this._configuration.additionalModuleKindsToEmit) {
      const specifiedKinds: Set<TTypescript.ModuleKind> = new Set<TTypescript.ModuleKind>();
      const specifiedOutDirs: Set<string> = new Set<string>();

      for (const additionalModuleKindToEmit of this._configuration.additionalModuleKindsToEmit) {
        const moduleKind: TTypescript.ModuleKind = this._parseModuleKind(
          ts,
          additionalModuleKindToEmit.moduleKind
        );

        if (tsconfig.options.module === moduleKind) {
          throw new Error(
            `Module kind "${additionalModuleKindToEmit.moduleKind}" is already specified in the tsconfig file.`
          );
        } else if (tsconfigOutFolderName === additionalModuleKindToEmit.outFolderPath) {
          throw new Error(
            `Output folder "${additionalModuleKindToEmit.outFolderPath}" is already specified in the tsconfig file.`
          );
        } else if (specifiedKinds.has(moduleKind)) {
          throw new Error(
            `Module kind "${additionalModuleKindToEmit.moduleKind}" is specified in more than one ` +
              'additionalModuleKindsToEmit entry.'
          );
        } else if (specifiedOutDirs.has(additionalModuleKindToEmit.outFolderPath)) {
          throw new Error(
            `Output folder "${additionalModuleKindToEmit.outFolderPath}" is specified in more than one ` +
              'additionalModuleKindsToEmit entry.'
          );
        } else {
          const outFolderPath: string = this._addModuleKindToEmit(
            moduleKind,
            additionalModuleKindToEmit.outFolderPath,
            false
          );
          specifiedKinds.add(moduleKind);
          specifiedOutDirs.add(outFolderPath);
        }
      }
    }
  }

  private _addModuleKindToEmit(
    moduleKind: TTypescript.ModuleKind,
    outFolderPath: string,
    isPrimary: boolean
  ): string {
    let outFolderName: string;
    if (path.isAbsolute(outFolderPath)) {
      outFolderName = path.relative(this._configuration.buildFolder, outFolderPath);
    } else {
      outFolderName = outFolderPath;
      outFolderPath = path.resolve(this._configuration.buildFolder, outFolderPath);
    }

    this._moduleKindsToEmit.push({
      outFolderPath: outFolderPath,
      moduleKind,
      cacheOutFolderPath: path
        .resolve(this._configuration.buildCacheFolder, outFolderName)
        .replace(/\\/g, '/'),
      isPrimary
    });

    return outFolderName;
  }

  private _loadTsconfig(ts: ExtendedTypeScript): TTypescript.ParsedCommandLine {
    const parsedConfigFile: ReturnType<typeof ts.readConfigFile> = ts.readConfigFile(
      this._configuration.tsconfigPath,
      this._fileSystem.readFile
    );
    const currentFolder: string = path.dirname(this._configuration.tsconfigPath);
    const tsconfig: TTypescript.ParsedCommandLine = ts.parseJsonConfigFileContent(
      parsedConfigFile.config,
      {
        fileExists: this._fileSystem.exists,
        readFile: this._fileSystem.readFile,
        readDirectory: (
          folderPath: string,
          extensions?: ReadonlyArray<string>,
          excludes?: ReadonlyArray<string>,
          includes?: ReadonlyArray<string>,
          depth?: number
        ) =>
          ts.matchFiles(
            folderPath,
            extensions,
            excludes,
            includes,
            /* useCaseSensitiveFileNames */ true,
            currentFolder,
            depth,
            this._fileSystem.readFolderFilesAndDirectories.bind(this._fileSystem),
            this._fileSystem.getRealPath.bind(this._fileSystem)
          ),
        useCaseSensitiveFileNames: true
      },
      currentFolder
    );

    tsconfig.options.incremental = true;
    tsconfig.options.tsBuildInfoFile = this._tsCacheFilePath;

    return tsconfig;
  }

  private _buildIncrementalCompilerHost(
    ts: ExtendedTypeScript,
    tsconfig: TTypescript.ParsedCommandLine
  ): TTypescript.CompilerHost {
    const compilerHost: TTypescript.CompilerHost = ts.createIncrementalCompilerHost(tsconfig.options);

    compilerHost.realpath = this._fileSystem.getRealPath.bind(this._fileSystem);
    compilerHost.readFile = (filePath: string) => {
      try {
        return this._fileSystem.readFile(filePath, {});
      } catch (error) {
        if (this._fileSystem.isNotExistError(error)) {
          return undefined;
        } else {
          throw error;
        }
      }
    };
    compilerHost.fileExists = this._fileSystem.exists.bind(this._fileSystem);
    compilerHost.directoryExists = (directoryPath: string) => {
      try {
        const stats: FileSystemStats = this._fileSystem.getStatistics(directoryPath);
        return stats.isDirectory() || stats.isSymbolicLink();
      } catch (error) {
        if (this._fileSystem.isNotExistError(error)) {
          return false;
        } else {
          throw error;
        }
      }
    };
    compilerHost.getDirectories = (folderPath: string) =>
      this._fileSystem.readFolderFilesAndDirectories(folderPath).directories;

    return compilerHost;
  }

  private _buildWatchCompilerHost(
    ts: ExtendedTypeScript,
    tsconfig: TTypescript.ParsedCommandLine
  ): TWatchCompilerHost {
    return ts.createWatchCompilerHost(
      tsconfig.fileNames,
      tsconfig.options,
      ts.sys,
      (
        rootNames: ReadonlyArray<string> | undefined,
        options: TTypescript.CompilerOptions | undefined,
        host?: TTypescript.CompilerHost,
        oldProgram?: TTypescript.EmitAndSemanticDiagnosticsBuilderProgram,
        configFileParsingDiagnostics?: ReadonlyArray<TTypescript.Diagnostic>,
        projectReferences?: ReadonlyArray<TTypescript.ProjectReference> | undefined
      ) => {
        // TODO: Support additionalModuleKindsToEmit
        return ts.createEmitAndSemanticDiagnosticsBuilderProgram(
          rootNames,
          options,
          host,
          oldProgram,
          configFileParsingDiagnostics,
          projectReferences
        );
      },
      (diagnostic: TTypescript.Diagnostic) => this._printDiagnosticMessage(ts, diagnostic),
      (diagnostic: TTypescript.Diagnostic) => this._printDiagnosticMessage(ts, diagnostic),
      tsconfig.projectReferences
    );
  }

  private _overrideTypeScriptReadJson(ts: ExtendedTypeScript): void {
    ts.readJson = (filePath: string) => {
      let jsonData: object | undefined = this._tsReadJsonCache.get(filePath);
      if (jsonData) {
        return jsonData;
      } else {
        try {
          const fileContents: string = this._fileSystem.readFile(filePath);
          if (!fileContents) {
            jsonData = EMPTY_JSON;
          } else {
            const parsedFile: ReturnType<typeof ts.parseConfigFileTextToJson> = ts.parseConfigFileTextToJson(
              filePath,
              fileContents
            );
            if (parsedFile.error) {
              jsonData = EMPTY_JSON;
            } else {
              jsonData = parsedFile.config as object;
            }
          }
        } catch (error) {
          jsonData = EMPTY_JSON;
        }

        this._tsReadJsonCache.set(filePath, jsonData);
        return jsonData;
      }
    };
  }

  private async _runTslintAsync(options: IRunTslintOptions): Promise<TTslint.LintResult> {
    const { tslint, tsProgram, typeScriptFilenames, measurePerformance, changedFiles } = options;

    const tslintConfigHash: crypto.Hash = this._getConfigHash(
      this._tslintConfigFilePath,
      this._tslintTerminal
    );
    const tslintConfigVersion: string = `${tslint.Linter.VERSION}_${tslintConfigHash.digest('hex')}`;

    let tslintCacheData: ITsLintCacheData | undefined;
    try {
      tslintCacheData = await JsonFile.loadAsync(this._tslintCacheFilePath);
    } catch (e) {
      if (this._fileSystem.isNotExistError(e)) {
        tslintCacheData = undefined;
      } else {
        throw e;
      }
    }

    const cachedNoFailureFileVersions: Map<string, string> = new Map<string, string>(
      tslintCacheData?.cacheVersion === tslintConfigVersion ? tslintCacheData.fileVersions : []
    );

    const newNoFailureFileVersions: Map<string, string> = new Map<string, string>();

    const tslintConfiguration: TTslint.Configuration.IConfigurationFile = tslint.Configuration.loadConfigurationFromPath(
      this._tslintConfigFilePath
    );
    const linter: IExtendedLinter = (new tslint.Linter(
      {
        fix: false,
        rulesDirectory: tslintConfiguration.rulesDirectory
      },
      tsProgram
    ) as unknown) as IExtendedLinter;

    const enabledRules: TTslint.IRule[] = linter.getEnabledRules(tslintConfiguration, false);

    //#region Code from TSLint
    // This code comes from here:
    // https://github.com/palantir/tslint/blob/24d29e421828348f616bf761adb3892bcdf51662/src/linter.ts#L161-L179
    // Modified to only lint files that have changed and that we care about
    //
    // TODO: (if we care) maybe extend the Tslint.Linter class to clean this up
    const lintFailures: TTslint.RuleFailure[] = [];

    const ruleSeverityMap: Map<string, TTslint.RuleSeverity> = new Map<string, TTslint.RuleSeverity>(
      enabledRules.map((rule): [string, TTslint.RuleSeverity] => [
        rule.getOptions().ruleName,
        rule.getOptions().ruleSeverity
      ])
    );

    for (const sourceFile of tsProgram.getSourceFiles()) {
      const filePath: string = sourceFile.fileName;

      if (
        !typeScriptFilenames.has(filePath) ||
        tslint.Configuration.isFileExcluded(filePath, tslintConfiguration)
      ) {
        continue;
      }

      const version: string = sourceFile.version;
      if (cachedNoFailureFileVersions.get(filePath) !== version || changedFiles.has(sourceFile)) {
        measurePerformance('Lint', () => {
          const failures: TTslint.RuleFailure[] = linter.getAllFailures(sourceFile, enabledRules);
          if (failures.length === 0) {
            newNoFailureFileVersions.set(filePath, version);
          } else {
            for (const failure of failures) {
              const severity: TTslint.RuleSeverity | undefined = ruleSeverityMap.get(failure.getRuleName());
              if (severity === undefined) {
                throw new Error(`Severity for rule '${failure.getRuleName()}' not found`);
              }

              failure.setRuleSeverity(severity);
              lintFailures.push(failure);
            }
          }
        });
      } else {
        newNoFailureFileVersions.set(filePath, version);
      }
    }

    linter.failures = lintFailures;
    //#endregion

    const updatedTslintCacheData: ITsLintCacheData = {
      cacheVersion: tslintConfigVersion,
      fileVersions: Array.from(newNoFailureFileVersions)
    };
    await JsonFile.saveAsync(updatedTslintCacheData, this._tslintCacheFilePath, { ensureFolderExists: true });

    return linter.getResult();
  }

  private _getConfigHash(configPath: string, terminal: Terminal): crypto.Hash {
    interface IMinimalConfig {
      extends?: string;
    }

    terminal.writeVerboseLine(`Examining config file "${configPath}"`);

    const rawConfig: string =
      configPath === this._tslintConfigFilePath
        ? this._rawProjectTslintFile!
        : this._fileSystem.readFile(configPath);
    const parsedConfig: IMinimalConfig = JsonFile.parseString(rawConfig);
    let hash: crypto.Hash;
    if (parsedConfig.extends) {
      const extendsFullPath: string = ResolveUtilities.resolvePackagePath(
        parsedConfig.extends,
        path.dirname(configPath)
      );
      hash = this._getConfigHash(extendsFullPath, terminal);
    } else {
      hash = crypto.createHash('sha1').update(rawConfig);
    }

    return hash.update(rawConfig);
  }

  private _parseModuleKind(ts: ExtendedTypeScript, moduleKindName: string): TTypescript.ModuleKind {
    switch (moduleKindName.toLowerCase()) {
      case 'commonjs':
        return ts.ModuleKind.CommonJS;

      case 'amd':
        return ts.ModuleKind.AMD;

      case 'umd':
        return ts.ModuleKind.UMD;

      case 'system':
        return ts.ModuleKind.System;

      case 'es2015':
        return ts.ModuleKind.ES2015;

      case 'esnext':
        return ts.ModuleKind.ESNext;

      default:
        throw new Error(`"${moduleKindName}" is not a valid module kind name.`);
    }
  }
}
