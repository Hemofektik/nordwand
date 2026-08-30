export function setTextOfElement(element: Node, text: string): void {
    if (element.firstChild) {
        element.firstChild.nodeValue = text;
        return;
    }
    element.appendChild(document.createTextNode(text));
}

export function requiredElement(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (element === null) {
        throw new Error(`Missing required element #${id}`);
    }
    return element;
}
