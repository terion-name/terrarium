export const TERRARIUM_ANSIBLE_VERSION = "13.7.0";
export const TERRARIUM_ANSIBLE_PIP_PACKAGES = [`ansible==${TERRARIUM_ANSIBLE_VERSION}`, "passlib==1.7.4"];
export const TERRARIUM_ANSIBLE_VENV = process.env.TERRARIUM_ANSIBLE_VENV ?? "/opt/terrarium/ansible-venv";
export const TERRARIUM_ANSIBLE_WHEELHOUSE = process.env.TERRARIUM_ANSIBLE_WHEELHOUSE ?? "/opt/terrarium/ansible-wheelhouse";
export const TERRARIUM_ANSIBLE_PYTHON = `${TERRARIUM_ANSIBLE_VENV}/bin/python`;
export const TERRARIUM_ANSIBLE_GALAXY = `${TERRARIUM_ANSIBLE_VENV}/bin/ansible-galaxy`;
export const TERRARIUM_ANSIBLE_PLAYBOOK = `${TERRARIUM_ANSIBLE_VENV}/bin/ansible-playbook`;
