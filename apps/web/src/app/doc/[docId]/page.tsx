import EditorShell from '@/components/EditorShell';

export default function DocPage({ params }: { params: { docId: string } }) {
  return <EditorShell docId={params.docId} />;
}
