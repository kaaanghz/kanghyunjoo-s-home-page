const helpButton = document.querySelector('.help');
const helpPopup = document.querySelector('.help-popup');
const closeHelp = document.querySelector('.close-help');
const infoDefault = document.querySelector('.info-default');
const infoItem = document.querySelector('.info-item');
const homePage = document.querySelector('.home-page');
const aboutPage = document.querySelector('.about-page');
const interactivePage = document.querySelector('.interactive-page');
const diggingPage = document.querySelector('.digging-page');
const pageLinks = document.querySelectorAll('[data-page]');
const interactiveProjectLinks = document.querySelectorAll('[data-interactive-project]');
const interactiveProjectDetails = document.querySelectorAll('[data-detail-for]');
const interactiveDetail = document.querySelector('.interactive-detail');
const diggingItems = document.querySelectorAll('.digging-item');
const diggingBoard = document.querySelector('.digging-board');
const shell = document.querySelector('.shell');

let infoKind = 'default';
let activeItem = null;
const exampleIds = {
  'project-01': 'track_to_move',
  'project-02': 'thumbs_up_to_click',
  'project-03': 'balloon_face',
};
let viewedExample = null;
let viewedAt = 0;

function trackEvent(name, parameters) {
  if (typeof window.gtag === 'function') window.gtag('event', name, parameters);
}

function updateExampleView(nextExample, endReason = 'navigation') {
  if (viewedExample === nextExample) return;
  if (viewedExample) {
    trackEvent('example_view_end', {
      example_id: exampleIds[viewedExample],
      duration_seconds: Math.round((performance.now() - viewedAt) / 1000),
      end_reason: endReason,
    });
  }
  viewedExample = nextExample;
  if (nextExample) {
    viewedAt = performance.now();
    trackEvent('example_view_start', { example_id: exampleIds[nextExample] });
  }
}

function setHelp(open) {
  helpPopup.classList.toggle('open', open);
  helpButton.setAttribute('aria-expanded', String(open));
  if (!open) {
    diggingItems.forEach(item => item.classList.remove('selected'));
    activeItem = null;
  }
}

function positionItemPopup() {
  if (!helpPopup.classList.contains('open') || infoKind !== 'item' || !activeItem) return;
  const shellRect = shell.getBoundingClientRect();
  const itemRect = activeItem.getBoundingClientRect();
  const popupWidth = helpPopup.offsetWidth;
  const gap = 12;
  const rightSide = itemRect.right - shellRect.left + gap;
  const leftSide = itemRect.left - shellRect.left - popupWidth - gap;
  const left = rightSide + popupWidth <= shell.clientWidth - 8
    ? rightSide
    : Math.max(8, leftSide);
  const top = Math.max(100, Math.min(
    itemRect.top - shellRect.top + 20,
    shell.scrollHeight - helpPopup.offsetHeight - 8
  ));
  helpPopup.style.left = `${left}px`;
  helpPopup.style.top = `${top}px`;
  helpPopup.style.right = 'auto';
}

function showInfo(kind = 'default', item = null) {
  infoKind = kind;
  const isItem = kind === 'item';
  activeItem = isItem ? item : null;
  infoDefault.hidden = isItem;
  infoItem.hidden = !isItem;
  helpPopup.classList.toggle('item-info', isItem);
  helpPopup.querySelector('strong').textContent = isItem ? item.dataset.title : 'Info';
  if (isItem) {
    infoItem.querySelector('.description-ko').textContent = item.dataset.descriptionKo;
    infoItem.querySelector('.description-en').textContent = item.dataset.descriptionEn;
  }
  diggingItems.forEach(diggingItem => diggingItem.classList.toggle('selected', diggingItem === item));
  if (!isItem) {
    helpPopup.style.left = '';
    helpPopup.style.top = '';
    helpPopup.style.right = '';
  }
  setHelp(true);
  if (isItem) positionItemPopup();
}

function renderPage() {
  const [requestedPage, requestedProject] = location.hash.slice(1).split('/');
  const currentPage = ['home', 'about', 'interactive', 'digging'].includes(requestedPage) ? requestedPage : 'home';
  homePage.hidden = currentPage !== 'home';
  aboutPage.hidden = currentPage !== 'about';
  interactivePage.hidden = currentPage !== 'interactive';
  diggingPage.hidden = currentPage !== 'digging';
  const activeProject = currentPage === 'interactive' && [...interactiveProjectDetails]
    .some(detail => detail.dataset.detailFor === requestedProject) ? requestedProject : null;
  updateExampleView(activeProject);
  interactiveDetail.hidden = !activeProject;
  interactiveProjectDetails.forEach(detail => {
    detail.hidden = detail.dataset.detailFor !== activeProject;
  });
  interactiveProjectLinks.forEach(link => {
    const selected = link.dataset.interactiveProject === activeProject;
    link.classList.toggle('selected', selected);
    if (selected) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
  pageLinks.forEach(link => {
    const selected = link.dataset.page === currentPage;
    link.classList.toggle('selected', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  infoKind = 'default';
  setHelp(false);
  window.scrollTo(0, 0);
}

pageLinks.forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    history.pushState(null, '', link.getAttribute('href'));
    renderPage();
  });
});

interactiveProjectLinks.forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    history.pushState(null, '', link.getAttribute('href'));
    renderPage();
  });
});

document.querySelectorAll('.interactive-live-link').forEach(link => {
  link.addEventListener('click', () => {
    const project = link.closest('[data-detail-for]')?.dataset.detailFor;
    if (project) trackEvent('example_launch', { example_id: exampleIds[project] });
  });
});

window.addEventListener('popstate', renderPage);
window.addEventListener('hashchange', renderPage);
window.addEventListener('pagehide', () => updateExampleView(null, 'page_exit'));
window.addEventListener('pageshow', event => {
  if (event.persisted) renderPage();
});
renderPage();

helpButton.addEventListener('click', () => {
  if (helpPopup.classList.contains('open') && infoKind === 'default') setHelp(false);
  else showInfo('default');
});

closeHelp.addEventListener('click', () => setHelp(false));

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') setHelp(false);
});

// Each cutout has its own description, drag position, and size.
let drag = null;
let suppressClick = false;

diggingItems.forEach(item => {
  const image = item.querySelector('img');
  const maxItemWidth = () => {
    const ratio = image.naturalWidth ? image.naturalHeight / image.naturalWidth : 1;
    return Math.max(80, Math.min(
      diggingBoard.clientWidth - item.offsetLeft - 10,
      (diggingBoard.clientHeight - item.offsetTop - 10) / ratio
    ));
  };

  item.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const resizing = event.target.classList.contains('resize-handle');
    const rotating = event.target.classList.contains('rotate-handle');
    const mode = rotating ? 'rotate' : resizing ? 'resize' : 'move';
    const rect = item.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    suppressClick = mode !== 'move';
    drag = {
      item,
      mode,
      x:event.clientX,
      y:event.clientY,
      left:item.offsetLeft,
      top:item.offsetTop,
      width:item.offsetWidth,
      rotation:Number(item.dataset.rotation || 0),
      centerX,
      centerY,
      pointerAngle:Math.atan2(event.clientY - centerY, event.clientX - centerX),
      moved:false,
    };
    item.setPointerCapture(event.pointerId);
  });

  item.addEventListener('pointermove', event => {
    if (!drag || drag.item !== item) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (!drag.moved) return;

    if (drag.mode === 'rotate') {
      item.classList.add('rotating');
      const angle = Math.atan2(event.clientY - drag.centerY, event.clientX - drag.centerX);
      let difference = angle - drag.pointerAngle;
      if (difference > Math.PI) difference -= 2 * Math.PI;
      if (difference < -Math.PI) difference += 2 * Math.PI;
      drag.rotation += difference * 180 / Math.PI;
      drag.pointerAngle = angle;
      item.dataset.rotation = String(drag.rotation);
      item.style.setProperty('--item-rotation', `${drag.rotation}deg`);
    } else if (drag.mode === 'resize') {
      item.classList.add('resizing');
      const radians = drag.rotation * Math.PI / 180;
      const localDx = dx * Math.cos(radians) + dy * Math.sin(radians);
      item.style.width = `${Math.max(80, Math.min(maxItemWidth(), drag.width + localDx))}px`;
    } else {
      item.classList.add('dragging');
      const maxLeft = Math.max(0, diggingBoard.clientWidth - item.offsetWidth);
      const maxTop = Math.max(0, diggingBoard.clientHeight - item.offsetHeight);
      item.style.left = `${Math.min(maxLeft, Math.max(0, drag.left + dx))}px`;
      item.style.top = `${Math.min(maxTop, Math.max(0, drag.top + dy))}px`;
    }
    positionItemPopup();
  });

  item.addEventListener('pointerup', () => {
    if (!drag || drag.item !== item) return;
    suppressClick = drag.moved || drag.mode !== 'move';
    drag = null;
    item.classList.remove('dragging', 'resizing', 'rotating');
  });

  item.addEventListener('pointercancel', () => {
    if (!drag || drag.item !== item) return;
    drag = null;
    item.classList.remove('dragging', 'resizing', 'rotating');
  });

  item.addEventListener('click', event => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    if (helpPopup.classList.contains('open') && activeItem === item) setHelp(false);
    else showInfo('item', item);
  });

  item.addEventListener('keydown', event => {
    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      const rotation = Number(item.dataset.rotation || 0) + (event.key === '[' ? -5 : 5);
      item.dataset.rotation = String(rotation);
      item.style.setProperty('--item-rotation', `${rotation}deg`);
      positionItemPopup();
      return;
    }
    if (event.key !== '+' && event.key !== '-' && event.key !== '=') return;
    event.preventDefault();
    const delta = event.key === '-' ? -20 : 20;
    item.style.width = `${Math.max(80, Math.min(maxItemWidth(), item.offsetWidth + delta))}px`;
    positionItemPopup();
  });
});

window.addEventListener('resize', positionItemPopup);
