// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Lib1Namespace } from 'api-extractor-lib1-test';
import Inner2 = Lib1Namespace.Inner;
import Y2 = Lib1Namespace.Y;
import NS2 = Lib1Namespace;
import * as LocalNestedModule from './local-nested-module';
import { LocalNS } from './local-nested-module';
import * as ReExport from './re-export';
import LocalClass2 = LocalNestedModule.LocalModule.LocalClass;
import LocalNSClass2 = LocalNS.LocalNSClass;
import Lib1Interface2 = ReExport.Lib1Interface;

export interface Item {
  externalImport: Inner2.X;
  externalImport2: Y2;
  externalImport3: typeof NS2;
  localImportFromAstModule: LocalClass2;
  localImportFromNamespace: LocalNSClass2;
  reExport: Lib1Interface2;
}
