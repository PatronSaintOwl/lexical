/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type {
  DOMChildConversion,
  DOMConversion,
  DOMConversionFn,
  GridSelection,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  NodeSelection,
  ParsedNodeMap,
  RangeSelection,
  TextNode,
} from 'lexical';

import {
  $createNodeFromParse,
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isGridSelection,
  $isRangeSelection,
  $isTextNode,
} from 'lexical';

const IGNORE_TAGS = new Set(['STYLE']);

export function $getHtmlContent(editor: LexicalEditor): string | null {
  const selection = $getSelection();

  if (selection == null) {
    throw new Error('Expected valid LexicalSelection');
  }

  // If we haven't selected anything
  if (
    ($isRangeSelection(selection) && selection.isCollapsed()) ||
    selection.getNodes().length === 0
  ) {
    return null;
  }

  return $convertSelectedLexicalContentToHtml(editor, selection);
}

export function $appendSelectedLexicalNodesToHTML(
  editor: LexicalEditor,
  selection: RangeSelection | NodeSelection | GridSelection,
  node: LexicalNode,
  parentElement: HTMLElement,
) {
  const nodeToConvert = $isTextNode(node)
    ? $processSelectedTextNode(selection, node)
    : node;
  const {element, after} = nodeToConvert.exportDOM(editor);
  if (!element) return;
  const children = $isElementNode(nodeToConvert)
    ? nodeToConvert.getChildren()
    : [];
  if (node.isSelected()) {
    parentElement.append(element);
  }
  for (let i = 0; i < children.length; i++) {
    const childNode = children[i];
    $appendSelectedLexicalNodesToHTML(
      editor,
      selection,
      childNode,
      node.isSelected() ? element : parentElement,
    );
  }
  if (node.isSelected() && after) {
    const newElement = after.call(nodeToConvert, element);
    if (newElement) element.replaceWith(newElement);
  }
}

export function $convertSelectedLexicalContentToHtml(
  editor: LexicalEditor,
  selection: RangeSelection | NodeSelection | GridSelection,
): string {
  const container = document.createElement('div');
  const root = $getRoot();
  const topLevelChildren = root.getChildren();
  for (let i = 0; i < topLevelChildren.length; i++) {
    const topLevelNode = topLevelChildren[i];
    $appendSelectedLexicalNodesToHTML(
      editor,
      selection,
      topLevelNode,
      container,
    );
  }
  return container.innerHTML;
}

export function $appendSelectedLexicalNodesToClone(
  editor: LexicalEditor,
  selection: RangeSelection | NodeSelection | GridSelection,
  currentNode: LexicalNode,
  nodeMap: Array<[NodeKey, LexicalNode]>,
  range: Array<NodeKey>,
  shouldIncludeInRange: boolean = true,
): Array<NodeKey> {
  const nodeToConvert = $isTextNode(currentNode)
    ? $processSelectedTextNode(selection, currentNode)
    : currentNode;
  const children = $isElementNode(currentNode) ? currentNode.getChildren() : [];
  const nodeKeys = [];
  let includeChildrenInRange = shouldIncludeInRange;
  let shouldExtractWithChildren = false;
  if (shouldIncludeInRange && currentNode.isSelected()) {
    includeChildrenInRange = false;
  }
  for (let i = 0; i < children.length; i++) {
    const childNode = children[i];
    const childNodeKeys = $appendSelectedLexicalNodesToClone(
      editor,
      selection,
      childNode,
      nodeMap,
      range,
      includeChildrenInRange,
    );
    if (includeChildrenInRange) {
      nodeKeys.push(...childNodeKeys);
    }
    if (
      !shouldExtractWithChildren &&
      $isElementNode(currentNode) &&
      childNode.isSelected() &&
      currentNode.extractWithChild(childNode, selection)
    ) {
      shouldExtractWithChildren = true;
    }
  }
  if (currentNode.isSelected() || shouldExtractWithChildren) {
    nodeMap.push([nodeToConvert.getKey(), nodeToConvert]);
    if (shouldIncludeInRange) {
      return [currentNode.getKey()];
    }
  }
  return nodeKeys;
}

export function $cloneSelectedLexicalContent(
  editor: LexicalEditor,
  selection: RangeSelection | NodeSelection | GridSelection,
): {
  nodeMap: Array<[NodeKey, LexicalNode]>,
  range: Array<NodeKey>,
} {
  const root = $getRoot();
  const nodeMap = [];
  const range = [];
  const topLevelChildren = root.getChildren();
  for (let i = 0; i < topLevelChildren.length; i++) {
    const topLevelNode = topLevelChildren[i];
    const nodeKeys = $appendSelectedLexicalNodesToClone(
      editor,
      selection,
      topLevelNode,
      nodeMap,
      range,
      true,
    );
    if (nodeKeys.length) {
      range.push(...nodeKeys);
    }
  }

  return {nodeMap, range};
}

export function $getLexicalContent(editor: LexicalEditor): string | null {
  const selection = $getSelection();
  if (selection !== null) {
    const namespace = editor._config.namespace;
    const state = $cloneSelectedLexicalContent(editor, selection);
    return JSON.stringify({namespace, state});
  }
  return null;
}

export function $insertDataTransferForPlainText(
  dataTransfer: DataTransfer,
  selection: RangeSelection,
): void {
  const text = dataTransfer.getData('text/plain');
  if (text != null) {
    selection.insertRawText(text);
  }
}

export function $insertDataTransferForRichText(
  dataTransfer: DataTransfer,
  selection: RangeSelection,
  editor: LexicalEditor,
): void {
  const lexicalNodesString = dataTransfer.getData(
    'application/x-lexical-editor',
  );

  if (lexicalNodesString) {
    const namespace = editor._config.namespace;
    try {
      const lexicalClipboardData = JSON.parse(lexicalNodesString);
      if (lexicalClipboardData.namespace === namespace) {
        const nodeRange = lexicalClipboardData.state;
        const nodes = $generateNodes(nodeRange);
        selection.insertNodes(nodes);
        return;
      }
    } catch (e) {
      // Malformed, missing nodes..
    }
  }

  const textHtmlMimeType = 'text/html';
  const htmlString = dataTransfer.getData(textHtmlMimeType);

  if (htmlString) {
    const parser = new DOMParser();
    const dom = parser.parseFromString(htmlString, textHtmlMimeType);
    const nodes = $generateNodesFromDOM(dom, editor);
    // Wrap text and inline nodes in paragraph nodes so we have all blocks at the top-level
    const topLevelBlocks = [];
    let currentBlock = null;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!$isElementNode(node) || node.isInline()) {
        if (currentBlock === null) {
          currentBlock = $createParagraphNode();
          topLevelBlocks.push(currentBlock);
        }
        if (currentBlock !== null) {
          currentBlock.append(node);
        }
      } else {
        topLevelBlocks.push(node);
        currentBlock = null;
      }
    }
    selection.insertNodes(topLevelBlocks);
    return;
  }
  $insertDataTransferForPlainText(dataTransfer, selection);
}

function $generateNodes(nodeRange: {
  nodeMap: ParsedNodeMap,
  range: Array<NodeKey>,
}): Array<LexicalNode> {
  const {range, nodeMap} = nodeRange;
  const parsedNodeMap: ParsedNodeMap = new Map(nodeMap);
  const nodes = [];
  for (let i = 0; i < range.length; i++) {
    const key = range[i];
    const parsedNode = parsedNodeMap.get(key);
    if (parsedNode !== undefined) {
      const node = $createNodeFromParse(parsedNode, parsedNodeMap);
      nodes.push(node);
    }
  }
  return nodes;
}

function getConversionFunction(
  domNode: Node,
  editor: LexicalEditor,
): DOMConversionFn | null {
  const {nodeName} = domNode;
  const cachedConversions = editor._htmlConversions.get(nodeName.toLowerCase());
  let currentConversion: DOMConversion | null = null;
  if (cachedConversions !== undefined) {
    cachedConversions.forEach((cachedConversion) => {
      const domConversion = cachedConversion(domNode);
      if (domConversion !== null) {
        if (
          currentConversion === null ||
          currentConversion.priority < domConversion.priority
        ) {
          currentConversion = domConversion;
        }
      }
    });
  }
  return currentConversion !== null ? currentConversion.conversion : null;
}

function $createNodesFromDOM(
  node: Node,
  editor: LexicalEditor,
  forChildMap: Map<string, DOMChildConversion> = new Map(),
  parentLexicalNode: ?LexicalNode | null,
): Array<LexicalNode> {
  let lexicalNodes: Array<LexicalNode> = [];

  if (IGNORE_TAGS.has(node.nodeName)) {
    return lexicalNodes;
  }

  let currentLexicalNode = null;
  const transformFunction = getConversionFunction(node, editor);
  const transformOutput = transformFunction ? transformFunction(node) : null;
  let postTransform = null;

  if (transformOutput !== null) {
    postTransform = transformOutput.after;
    currentLexicalNode = transformOutput.node;
    if (currentLexicalNode !== null) {
      for (const [, forChildFunction] of forChildMap) {
        currentLexicalNode = forChildFunction(
          currentLexicalNode,
          parentLexicalNode,
        );

        if (!currentLexicalNode) {
          break;
        }
      }

      if (currentLexicalNode) {
        lexicalNodes.push(currentLexicalNode);
      }
    }

    if (transformOutput.forChild != null) {
      forChildMap.set(node.nodeName, transformOutput.forChild);
    }
  }

  // If the DOM node doesn't have a transformer, we don't know what
  // to do with it but we still need to process any childNodes.
  const children = node.childNodes;
  let childLexicalNodes = [];
  for (let i = 0; i < children.length; i++) {
    childLexicalNodes.push(
      ...$createNodesFromDOM(
        children[i],
        editor,
        forChildMap,
        currentLexicalNode,
      ),
    );
  }
  if (postTransform != null) {
    childLexicalNodes = postTransform(childLexicalNodes);
  }
  if (currentLexicalNode == null) {
    // If it hasn't been converted to a LexicalNode, we hoist its children
    // up to the same level as it.
    lexicalNodes = lexicalNodes.concat(childLexicalNodes);
  } else {
    if ($isElementNode(currentLexicalNode)) {
      // If the current node is a ElementNode after conversion,
      // we can append all the children to it.
      currentLexicalNode.append(...childLexicalNodes);
    }
  }
  return lexicalNodes;
}

function $generateNodesFromDOM(
  dom: Document,
  editor: LexicalEditor,
): Array<LexicalNode> {
  let lexicalNodes = [];
  const elements: Array<Node> = dom.body ? Array.from(dom.body.childNodes) : [];
  const elementsLength = elements.length;
  for (let i = 0; i < elementsLength; i++) {
    const element = elements[i];
    if (!IGNORE_TAGS.has(element.nodeName)) {
      const lexicalNode = $createNodesFromDOM(element, editor);
      if (lexicalNode !== null) {
        lexicalNodes = lexicalNodes.concat(lexicalNode);
      }
    }
  }
  return lexicalNodes;
}

export function $processSelectedTextNode(
  selection: RangeSelection | GridSelection | NodeSelection,
  node: TextNode,
): LexicalNode {
  let convertedNode = node;
  if (
    convertedNode.isSelected() &&
    ($isRangeSelection(selection) || $isGridSelection(selection))
  ) {
    const latest = convertedNode.getLatest();
    const constructor = latest.constructor;
    const clone = constructor.clone(latest);
    const anchorNode = selection.anchor.getNode();
    const focusNode = selection.focus.getNode();
    const isAnchor = node.is(anchorNode);
    const isFocus = node.is(focusNode);
    if (isAnchor || isFocus) {
      const [anchorOffset, focusOffset] = selection.getCharacterOffsets();
      const isBackward = selection.isBackward();
      const isSame = anchorNode.is(focusNode);
      const isFirst = clone.is(isBackward ? focusNode : anchorNode);
      const isLast = clone.is(isBackward ? anchorNode : focusNode);
      if (isSame) {
        const startOffset =
          anchorOffset > focusOffset ? focusOffset : anchorOffset;
        const endOffset =
          anchorOffset > focusOffset ? anchorOffset : focusOffset;
        const splitNodes = clone.splitText(startOffset, endOffset);
        convertedNode = startOffset === 0 ? splitNodes[0] : splitNodes[1];
      } else if (isFirst) {
        const offset = isBackward ? focusOffset : anchorOffset;
        const splitNodes = clone.splitText(offset);
        convertedNode = offset === 0 ? splitNodes[0] : splitNodes[1];
      } else if (isLast) {
        const offset = isBackward ? anchorOffset : focusOffset;
        const splitNodes = clone.splitText(offset);
        convertedNode = splitNodes[0];
      }
    }
  }
  return convertedNode;
}
