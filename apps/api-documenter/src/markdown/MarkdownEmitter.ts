// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  type DocNode,
  DocNodeKind,
  type StringBuilder,
  type DocPlainText,
  type DocHtmlStartTag,
  type DocHtmlEndTag,
  type DocCodeSpan,
  type DocLinkTag,
  type DocParagraph,
  type DocFencedCode,
  type DocSection,
  DocNodeTransforms,
  type DocEscapedText,
  type DocErrorText,
  type DocBlockTag
} from '@microsoft/tsdoc';
import { InternalError } from '@rushstack/node-core-library';

import { IndentedWriter } from '../utils/IndentedWriter';

export interface IMarkdownEmitterOptions {}

export interface IMarkdownEmitterContext<TOptions = IMarkdownEmitterOptions> {
  writer: IndentedWriter;

  boldRequested: boolean;
  italicRequested: boolean;

  writingBold: boolean;
  writingItalic: boolean;

  options: TOptions;
}

/**
 * Renders MarkupElement content in the Markdown file format.
 * For more info:  https://en.wikipedia.org/wiki/Markdown
 */
export class MarkdownEmitter {
  public emit(stringBuilder: StringBuilder, docNode: DocNode, options: IMarkdownEmitterOptions): string {
    const writer: IndentedWriter = new IndentedWriter(stringBuilder);

    const context: IMarkdownEmitterContext = {
      writer,

      boldRequested: false,
      italicRequested: false,

      writingBold: false,
      writingItalic: false,

      options
    };

    this.writeNode(docNode, context, false);

    writer.ensureNewLine(); // finish the last line

    return writer.toString();
  }

  protected getEscapedText(text: string): string {
    const textWithBackslashes: string = text
      .replace(/\\/g, '\\\\') // first replace the escape character
      .replace(/[*#[\]_|`~]/g, (x) => '\\' + x) // then escape any special characters
      .replace(/---/g, '\\-\\-\\-') // hyphens only if it's 3 or more
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\{/g, '&#123;') // encode "{}" to be compatible with mdx
      .replace(/\}/g, '&#125;');
    return textWithBackslashes;
  }

  protected getTableEscapedText(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\|/g, '&#124;')
      .replace(/\{/g, '&#123;') // encode "{}" to be compatible with mdx
      .replace(/\}/g, '&#125;');
  }

  /**
   * @virtual
   */
  protected writeNode(docNode: DocNode, context: IMarkdownEmitterContext, docNodeSiblings: boolean): void {
    const writer: IndentedWriter = context.writer;

    switch (docNode.kind) {
      case DocNodeKind.PlainText: {
        const docPlainText: DocPlainText = docNode as DocPlainText;
        this.writePlainText(docPlainText.text, context);
        break;
      }
      case DocNodeKind.HtmlStartTag:
      case DocNodeKind.HtmlEndTag: {
        const docHtmlTag: DocHtmlStartTag | DocHtmlEndTag = docNode as DocHtmlStartTag | DocHtmlEndTag;
        // write the HTML element verbatim into the output
        writer.write(docHtmlTag.emitAsHtml());
        break;
      }
      case DocNodeKind.CodeSpan: {
        const docCodeSpan: DocCodeSpan = docNode as DocCodeSpan;
        writer.write('`');
        writer.write(docCodeSpan.code);
        writer.write('`');
        break;
      }
      case DocNodeKind.LinkTag: {
        const docLinkTag: DocLinkTag = docNode as DocLinkTag;
        if (docLinkTag.codeDestination) {
          this.writeLinkTagWithCodeDestination(docLinkTag, context);
        } else if (docLinkTag.urlDestination) {
          this.writeLinkTagWithUrlDestination(docLinkTag, context);
        } else if (docLinkTag.linkText) {
          this.writePlainText(docLinkTag.linkText, context);
        }
        break;
      }
      case DocNodeKind.Paragraph: {
        const docParagraph: DocParagraph = docNode as DocParagraph;
        const trimmedParagraph: DocParagraph = DocNodeTransforms.trimSpacesInParagraph(docParagraph);

        this.writeNodes(trimmedParagraph.nodes, context);
        writer.ensureNewLine();
        writer.writeLine();
        break;
      }
      case DocNodeKind.FencedCode: {
        const docFencedCode: DocFencedCode = docNode as DocFencedCode;
        writer.ensureNewLine();
        writer.write('```');
        writer.write(docFencedCode.language);
        writer.writeLine();
        writer.write(docFencedCode.code);
        writer.ensureNewLine();
        writer.writeLine('```');
        break;
      }
      case DocNodeKind.Section: {
        const docSection: DocSection = docNode as DocSection;
        this.writeNodes(docSection.nodes, context);
        break;
      }
      case DocNodeKind.SoftBreak: {
        if (!/^\s?$/.test(writer.peekLastCharacter())) {
          writer.write(' ');
        }
        break;
      }
      case DocNodeKind.EscapedText: {
        const docEscapedText: DocEscapedText = docNode as DocEscapedText;
        this.writePlainText(docEscapedText.decodedText, context);
        break;
      }
      case DocNodeKind.ErrorText: {
        const docErrorText: DocErrorText = docNode as DocErrorText;
        this.writePlainText(docErrorText.text, context);
        break;
      }
      case DocNodeKind.InlineTag: {
        break;
      }
      case DocNodeKind.BlockTag: {
        const tagNode: DocBlockTag = docNode as DocBlockTag;
        console.warn('Unsupported block tag: ' + tagNode.tagName);
        break;
      }
      default:
        throw new InternalError('Unsupported DocNodeKind kind: ' + docNode.kind);
    }
  }

  /** @virtual */
  protected writeLinkTagWithCodeDestination(docLinkTag: DocLinkTag, context: IMarkdownEmitterContext): void {
    // The subclass needs to implement this to support code destinations
    throw new InternalError('writeLinkTagWithCodeDestination()');
  }

  /** @virtual */
  protected writeLinkTagWithUrlDestination(docLinkTag: DocLinkTag, context: IMarkdownEmitterContext): void {
    const linkText: string =
      docLinkTag.linkText !== undefined ? docLinkTag.linkText : docLinkTag.urlDestination!;

    const encodedLinkText: string = this.getEscapedText(linkText.replace(/\s+/g, ' '));

    context.writer.write('[');
    context.writer.write(encodedLinkText);
    context.writer.write(`](${docLinkTag.urlDestination!})`);
  }

  protected writePlainText(text: string, context: IMarkdownEmitterContext): void {
    const writer: IndentedWriter = context.writer;

    // split out the [ leading whitespace, content, trailing whitespace ]
    const parts: string[] = text.match(/^(\s*)(.*?)(\s*)$/) || [];

    writer.write(parts[1]); // write leading whitespace

    const middle: string = parts[2];

    if (middle !== '') {
      switch (writer.peekLastCharacter()) {
        case '':
        case '\n':
        case ' ':
        case '[':
        case '>':
          // okay to put a symbol
          break;
        default:
          // This is no problem:        "**one** *two* **three**"
          // But this is trouble:       "**one***two***three**"
          // The most general solution: "**one**<!-- -->*two*<!-- -->**three**"
          //
          // Update: generate "**one**_two_**three**" instead now, "<!-- -->" fix is no longer needed. But it'll cause parsing error by mdx@1.x
          // writer.write('<!-- -->');
          break;
      }

      if (context.boldRequested) {
        writer.write('**');
      }
      if (context.italicRequested) {
        writer.write('_');
      }

      writer.write(this.getEscapedText(middle));

      if (context.italicRequested) {
        writer.write('_');
      }
      if (context.boldRequested) {
        writer.write('**');
      }
    }

    writer.write(parts[3]); // write trailing whitespace
  }

  protected writeNodes(docNodes: ReadonlyArray<DocNode>, context: IMarkdownEmitterContext): void {
    for (const docNode of docNodes) {
      this.writeNode(docNode, context, docNodes.length > 1);
    }
  }
}
