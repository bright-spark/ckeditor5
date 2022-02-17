/**
 * @license Copyright (c) 2003-2022, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module list/documentlist/documentlistediting
 */

import { Plugin } from 'ckeditor5/src/core';
import { Enter } from 'ckeditor5/src/enter';
import { Delete } from 'ckeditor5/src/typing';
import { CKEditorError } from 'ckeditor5/src/utils';

import DocumentListIndentCommand from './documentlistindentcommand';
import DocumentListCommand from './documentlistcommand';
import DocumentListMergeCommand from './documentlistmergecommand';
import DocumentListSplitCommand from './documentlistsplitcommand';
import {
	bogusParagraphCreator,
	listItemDowncastConverter,
	listItemUpcastConverter,
	listUpcastCleanList,
	reconvertItemsOnDataChange
} from './converters';
import {
	findAndAddListHeadToMap,
	fixListIndents,
	fixListItemIds
} from './utils/postfixers';
import {
	getAllListItemBlocks,
	isFirstBlockOfListItem,
	isLastBlockOfListItem,
	isSingleListItem,
	getSelectedBlockObject,
	isListItemBlock,
	LIST_BASE_ATTRIBUTES
} from './utils/model';
import {
	getViewElementIdForListType,
	getViewElementNameForListType
} from './utils/view';
import ListWalker, { iterateSiblingListBlocks } from './utils/listwalker';

import '../../theme/documentlist.css';

/**
 * The editing part of the document-list feature. It handles creating, editing and removing lists and list items.
 *
 * @extends module:core/plugin~Plugin
 */
export default class DocumentListEditing extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'DocumentListEditing';
	}

	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ Enter, Delete ];
	}

	/**
	 * @inheritDoc
	 */
	init() {
		/**
		 * The list of attributes that must be consistent among all items in the same list.
		 *
		 * @private
		 * @type {Array.<String>}
		 */
		this._sameListDefiningAttributes = [ 'listType' ];

		const editor = this.editor;
		const model = editor.model;

		if ( editor.plugins.has( 'ListEditing' ) ) {
			/**
			 * The `DocumentList` feature can not be loaded together with the `List` plugin.
			 *
			 * @error document-list-feature-conflict
			 * @param {String} conflictPlugin Name of the plugin.
			 */
			throw new CKEditorError( 'document-list-feature-conflict', this, { conflictPlugin: 'ListEditing' } );
		}

		model.schema.extend( '$container', { allowAttributes: LIST_BASE_ATTRIBUTES } );
		model.schema.extend( '$block', { allowAttributes: LIST_BASE_ATTRIBUTES } );
		model.schema.extend( '$blockObject', { allowAttributes: LIST_BASE_ATTRIBUTES } );

		model.on( 'insertContent', createModelIndentPasteFixer( model ), { priority: 'high' } );

		// Register commands.
		editor.commands.add( 'numberedList', new DocumentListCommand( editor, 'numbered' ) );
		editor.commands.add( 'bulletedList', new DocumentListCommand( editor, 'bulleted' ) );

		editor.commands.add( 'indentList', new DocumentListIndentCommand( editor, 'forward' ) );
		editor.commands.add( 'outdentList', new DocumentListIndentCommand( editor, 'backward' ) );

		editor.commands.add( 'mergeListItemBackward', new DocumentListMergeCommand( editor, 'backward' ) );
		editor.commands.add( 'mergeListItemForward', new DocumentListMergeCommand( editor, 'forward' ) );

		editor.commands.add( 'splitListItemBefore', new DocumentListSplitCommand( editor, 'before' ) );
		editor.commands.add( 'splitListItemAfter', new DocumentListSplitCommand( editor, 'after' ) );

		this._setupModelPostFixing();
		this._setupConversion();
		this._setupDeleteIntegration();
		this._setupEnterIntegration();
	}

	/**
	 * @inheritDoc
	 */
	afterInit() {
		const editor = this.editor;
		const commands = editor.commands;
		const indent = commands.get( 'indent' );
		const outdent = commands.get( 'outdent' );

		if ( indent ) {
			indent.registerChildCommand( commands.get( 'indentList' ) );
		}

		if ( outdent ) {
			outdent.registerChildCommand( commands.get( 'outdentList' ) );
		}
	}

	/**
	 * Register attribute that must be that must be consistent among all items in the same list.
	 * If list items have different values of registered attributes, they belong to different lists.
	 *
	 * @param {String} attributeName
	 */
	registerSameListDefiningAttributes( attributeName ) {
		this._sameListDefiningAttributes.push( attributeName );
	}

	/**
	 * Gets the list of attributes that must be consistent among all items in the same list.
	 *
	 * @returns {Array.<String>}
	 */
	getSameListDefiningAttributes() {
		return this._sameListDefiningAttributes;
	}

	/**
	 * Attaches the listener to the {@link module:engine/view/document~Document#event:delete} event and handles backspace/delete
	 * keys in and around document lists.
	 *
	 * @private
	 */
	_setupDeleteIntegration() {
		const editor = this.editor;
		const mergeBackwardCommand = editor.commands.get( 'mergeListItemBackward' );
		const mergeForwardCommand = editor.commands.get( 'mergeListItemForward' );

		this.listenTo( editor.editing.view.document, 'delete', ( evt, data ) => {
			const selection = editor.model.document.selection;

			editor.model.change( () => {
				const firstPosition = selection.getFirstPosition();

				if ( selection.isCollapsed && data.direction == 'backward' ) {
					if ( !firstPosition.isAtStart ) {
						return;
					}

					const positionParent = firstPosition.parent;

					if ( !isListItemBlock( positionParent ) ) {
						return;
					}

					const previousBlock = ListWalker.first( positionParent, {
						sameListAttributes: this.getSameListDefiningAttributes(),
						sameIndent: true
					} );

					// Outdent the first block of a first list item.
					if ( !previousBlock && positionParent.getAttribute( 'listIndent' ) === 0 ) {
						if ( !isLastBlockOfListItem( positionParent ) ) {
							editor.execute( 'splitListItemAfter' );
						}

						editor.execute( 'outdentList' );
					}
					// Merge block with previous one (on the block level or on the content level).
					else {
						if ( !mergeBackwardCommand.isEnabled ) {
							return;
						}

						mergeBackwardCommand.execute( {
							shouldMergeOnBlocksContentLevel: shouldMergeOnBlocksContentLevel( editor.model, 'backward' )
						} );
					}

					data.preventDefault();
					evt.stop();
				}
				// Non-collapsed selection or forward delete.
				else {
					// Collapsed selection should trigger forward merging only if at the end of a block.
					if ( selection.isCollapsed && !selection.getLastPosition().isAtEnd ) {
						return;
					}

					if ( !mergeForwardCommand.isEnabled ) {
						return;
					}

					mergeForwardCommand.execute( {
						shouldMergeOnBlocksContentLevel: shouldMergeOnBlocksContentLevel( editor.model, 'forward' )
					} );

					data.preventDefault();
					evt.stop();
				}
			} );
		}, { context: 'li' } );
	}

	/**
	 * Attaches a listener to the {@link module:engine/view/document~Document#event:enter} event and handles enter key press
	 * in document lists.
	 *
	 * @private
	 */
	_setupEnterIntegration() {
		const editor = this.editor;
		const model = editor.model;
		const commands = editor.commands;
		const enterCommand = commands.get( 'enter' );

		// Overwrite the default Enter key behavior: outdent or split the list in certain cases.
		this.listenTo( editor.editing.view.document, 'enter', ( evt, data ) => {
			const doc = model.document;
			const positionParent = doc.selection.getFirstPosition().parent;

			if ( doc.selection.isCollapsed && isListItemBlock( positionParent ) && positionParent.isEmpty ) {
				const isFirstBlock = isFirstBlockOfListItem( positionParent );
				const isLastBlock = isLastBlockOfListItem( positionParent );

				// * a      →      * a
				// * []     →      []
				if ( isFirstBlock && isLastBlock ) {
					editor.execute( 'outdentList' );

					data.preventDefault();
					evt.stop();
				}
				// * []     →      * []
				//   a      →      * a
				else if ( isFirstBlock && !isLastBlock ) {
					editor.execute( 'splitListItemAfter' );

					data.preventDefault();
					evt.stop();
				}
				// * a      →      * a
				//   []     →      * []
				else if ( isLastBlock ) {
					editor.execute( 'splitListItemBefore' );

					data.preventDefault();
					evt.stop();
				}
			}
		}, { context: 'li' } );

		// In some cases, after the default block splitting, we want to modify the new block to become a new list item
		// instead of an additional block in the same list item.
		this.listenTo( enterCommand, 'afterExecute', () => {
			const splitCommand = commands.get( 'splitListItemBefore' );

			// The command has not refreshed because the change block related to EnterCommand#execute() is not over yet.
			// Let's keep it up to date and take advantage of DocumentListSplitCommand#isEnabled.
			splitCommand.refresh();

			if ( !splitCommand.isEnabled ) {
				return;
			}

			const doc = editor.model.document;
			const positionParent = doc.selection.getLastPosition().parent;
			const listItemBlocks = getAllListItemBlocks( positionParent );

			// Keep in mind this split happens after the default enter handler was executed. For instance:
			//
			// │       Initial state       │    After default enter    │   Here in #afterExecute   │
			// ├───────────────────────────┼───────────────────────────┼───────────────────────────┤
			// │          * a[]            │           * a             │           * a             │
			// │                           │             []            │           * []            │
			if ( listItemBlocks.length === 2 ) {
				splitCommand.execute();
			}
		} );
	}

	/**
	 * Registers the conversion helpers for the document-list feature.
	 * @private
	 */
	_setupConversion() {
		const editor = this.editor;
		const model = editor.model;

		editor.conversion.for( 'upcast' )
			.elementToElement( { view: 'li', model: 'paragraph' } )
			.add( dispatcher => {
				dispatcher.on( 'element:li', listItemUpcastConverter() );
				dispatcher.on( 'element:ul', listUpcastCleanList(), { priority: 'high' } );
				dispatcher.on( 'element:ol', listUpcastCleanList(), { priority: 'high' } );
			} );

		editor.conversion.for( 'editingDowncast' )
			.elementToElement( {
				model: 'paragraph',
				view: bogusParagraphCreator(),
				converterPriority: 'high'
			} );

		editor.conversion.for( 'dataDowncast' )
			.elementToElement( {
				model: 'paragraph',
				view: bogusParagraphCreator( { dataPipeline: true } ),
				converterPriority: 'high'
			} );

		editor.conversion.for( 'downcast' )
			.add( dispatcher => {
				for ( const attributeName of LIST_BASE_ATTRIBUTES ) {
					dispatcher.on( `attribute:${ attributeName }`, listItemDowncastConverter( LIST_BASE_ATTRIBUTES, model ) );
				}
			} );

		this.listenTo( model.document, 'change:data', reconvertItemsOnDataChange( model, editor.editing, this ) );

		// For LI verify if an ID of the attribute element is correct.
		this.on( 'refreshChecker:item', ( evt, { viewElement, modelAttributes } ) => {
			if ( viewElement.id != modelAttributes.listItemId ) {
				evt.return = true;
				evt.stop();
			}
		} );

		// For UL and OL check if the name and ID of element is correct.
		this.on( 'refreshChecker:list', ( evt, { viewElement, modelAttributes } ) => {
			if (
				viewElement.name != getViewElementNameForListType( modelAttributes.listType ) ||
				viewElement.id != getViewElementIdForListType( modelAttributes.listType, modelAttributes.listIndent )
			) {
				evt.return = true;
				evt.stop();
			}
		} );
	}

	/**
	 * TODO
	 *
	 * @private
	 */
	_setupModelPostFixing() {
		const model = this.editor.model;

		// Register list fixing.
		// First the low level handler.
		model.document.registerPostFixer( writer => modelChangePostFixer( model, writer, this ) );

		// Then the callbacks for the specific lists.
		// The indentation fixing must be the first one...
		this.on( 'postFixer', ( evt, { listHead, writer } ) => {
			evt.return = fixListIndents( listHead, writer );
		}, { priority: 'high' } );

		// ...then the item ids... and after that other fixers that rely on the correct indentation and ids.
		this.on( 'postFixer', ( evt, { listHead, writer, seenIds } ) => {
			evt.return = fixListItemIds( listHead, seenIds, writer );
		}, { priority: 'high' } );
	}
}

// Post-fixer that reacts to changes on document and fixes incorrect model states (invalid `listItemId` and `listIndent` values).
//
// In the example below, there is a correct list structure.
// Then the middle element is removed so the list structure will become incorrect:
//
//		<paragraph listType="bulleted" listItemId="a" listIndent=0>Item 1</paragraph>
//		<paragraph listType="bulleted" listItemId="b" listIndent=1>Item 2</paragraph>   <--- this is removed.
//		<paragraph listType="bulleted" listItemId="c" listIndent=2>Item 3</paragraph>
//
// The list structure after the middle element is removed:
//
// 		<paragraph listType="bulleted" listItemId="a" listIndent=0>Item 1</paragraph>
//		<paragraph listType="bulleted" listItemId="c" listIndent=2>Item 3</paragraph>
//
// Should become:
//
//		<paragraph listType="bulleted" listItemId="a" listIndent=0>Item 1</paragraph>
//		<paragraph listType="bulleted" listItemId="c" listIndent=1>Item 3</paragraph>   <--- note that indent got post-fixed.
//
// @param {module:engine/model/model~Model} model The data model.
// @param {module:engine/model/writer~Writer} writer The writer to do changes with.
// @param {module:utils/emittermixin~Emitter} emitter The emitter that will fire events for fixing a list.
// @returns {Boolean} `true` if any change has been applied, `false` otherwise.
function modelChangePostFixer( model, writer, emitter ) {
	const changes = model.document.differ.getChanges();
	const itemToListHead = new Map();

	let applied = false;

	for ( const entry of changes ) {
		if ( entry.type == 'insert' && entry.name != '$text' ) {
			const item = entry.position.nodeAfter;

			// Remove attributes in case of renamed element.
			if ( !model.schema.checkAttribute( item, 'listItemId' ) ) {
				for ( const attributeName of Array.from( item.getAttributeKeys() ) ) {
					if ( attributeName.startsWith( 'list' ) ) {
						writer.removeAttribute( attributeName, item );

						applied = true;
					}
				}
			}

			findAndAddListHeadToMap( entry.position, itemToListHead );

			// Insert of a non-list item - check if there is a list after it.
			if ( !entry.attributes.has( 'listItemId' ) ) {
				findAndAddListHeadToMap( entry.position.getShiftedBy( entry.length ), itemToListHead );
			}

			// Check if there is no nested list.
			for ( const { item: innerItem, previousPosition } of model.createRangeIn( item ) ) {
				if ( isListItemBlock( innerItem ) ) {
					findAndAddListHeadToMap( previousPosition, itemToListHead );
				}
			}
		}
		// Removed list item.
		else if ( entry.type == 'remove' && entry.attributes.has( 'listItemId' ) ) {
			findAndAddListHeadToMap( entry.position, itemToListHead );
		}
		// Changed list item indent or type.
		else if ( entry.type == 'attribute' && [ 'listIndent', 'listType' ].includes( entry.attributeKey ) ) {
			findAndAddListHeadToMap( entry.range.start, itemToListHead );

			if ( entry.attributeNewValue === null ) {
				findAndAddListHeadToMap( entry.range.start.getShiftedBy( 1 ), itemToListHead );
			}
		}
	}

	// Make sure that IDs are not shared by split list.
	const seenIds = new Set();

	for ( const listHead of itemToListHead.values() ) {
		applied = emitter.fire( 'postFixer', { listHead, writer, seenIds } ) || applied;
	}

	return applied;
}

// A fixer for pasted content that includes list items.
//
// It fixes indentation of pasted list items so the pasted items match correctly to the context they are pasted into.
//
// Example:
//
//		<paragraph listType="bulleted" listItemId="a" listIndent=0>A</paragraph>
//		<paragraph listType="bulleted" listItemId="b" listIndent=1>B^</paragraph>
//		// At ^ paste:  <paragraph listType="bulleted" listItemId="x" listIndent=4>X</paragraph>
//		//              <paragraph listType="bulleted" listItemId="y" listIndent=5>Y</paragraph>
//		<paragraph listType="bulleted" listItemId="c" listIndent=2>C</paragraph>
//
// Should become:
//
//		<paragraph listType="bulleted" listItemId="a" listIndent=0>A</paragraph>
//		<paragraph listType="bulleted" listItemId="b" listIndent=1>BX</paragraph>
//		<paragraph listType="bulleted" listItemId="y" listIndent=2>Y/paragraph>
//		<paragraph listType="bulleted" listItemId="c" listIndent=2>C</paragraph>
//
function createModelIndentPasteFixer( model ) {
	return ( evt, [ content, selectable ] ) => {
		// Check whether inserted content starts from a `listItem`. If it does not, it means that there are some other
		// elements before it and there is no need to fix indents, because even if we insert that content into a list,
		// that list will be broken.
		// Note: we also need to handle singular elements because inserting item with indent 0 into 0,1,[],2
		// would create incorrect model.
		const item = content.is( 'documentFragment' ) ? content.getChild( 0 ) : content;

		if ( !isListItemBlock( item ) ) {
			return;
		}

		let selection;

		if ( !selectable ) {
			selection = model.document.selection;
		} else {
			selection = model.createSelection( selectable );
		}

		// Get a reference list item. Inserted list items will be fixed according to that item.
		const pos = selection.getFirstPosition();
		let refItem = null;

		if ( isListItemBlock( pos.parent ) ) {
			refItem = pos.parent;
		} else if ( isListItemBlock( pos.nodeBefore ) ) {
			refItem = pos.nodeBefore;
		}

		// If there is `refItem` it means that we do insert list items into an existing list.
		if ( !refItem ) {
			return;
		}

		// First list item in `data` has indent equal to 0 (it is a first list item). It should have indent equal
		// to the indent of reference item. We have to fix the first item and all of it's children and following siblings.
		// Indent of all those items has to be adjusted to reference item.
		const indentChange = refItem.getAttribute( 'listIndent' );

		// Fix only if there is anything to fix.
		if ( indentChange == 0 ) {
			return;
		}

		model.change( writer => {
			// Adjust indent of all "first" list items in inserted data.
			for ( const { node } of iterateSiblingListBlocks( item, 'forward' ) ) {
				writer.setAttribute( 'listIndent', node.getAttribute( 'listIndent' ) + indentChange, node );
			}
		} );
	};
}

// Decides whether the merge should be accompanied by the model's `deleteContent()`, for instance, to get rid of the inline
// content in the selection or take advantage of the heuristics in `deleteContent()` that helps convert lists into paragraphs
// in certain cases.
//
// @param {module:engine/model/model~Model} model
// @param {'backward'|'forward'} direction
// @returns {Boolean}
function shouldMergeOnBlocksContentLevel( model, direction ) {
	const selection = model.document.selection;

	if ( !selection.isCollapsed ) {
		return !getSelectedBlockObject( model );
	}

	if ( direction === 'forward' ) {
		return true;
	}

	const firstPosition = selection.getFirstPosition();
	const positionParent = firstPosition.parent;
	const previousSibling = positionParent.previousSibling;

	if ( model.schema.isObject( previousSibling ) ) {
		return false;
	}

	if ( previousSibling.isEmpty ) {
		return true;
	}

	return isSingleListItem( [ positionParent, previousSibling ] );
}
